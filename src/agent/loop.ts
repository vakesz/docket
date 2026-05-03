// Tool calls are dispatched internally — the loop never hands control
// back to the caller mid-turn. `ask_user_question` is the one exception:
// dispatch returns the structured payload, the loop emits the event,
// persists the assistant message with `pending: true`, and yields `done`
// without re-feeding. The next user message resumes a fresh `runTurn()`.

import "server-only";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { selectGuardrailFor } from "@/agent/guardrail/registry";
import type { Guardrail, GuardrailUsage } from "@/agent/guardrail/types";
import { extractUntrustedFields } from "@/agent/guardrail/types";
import type { LlmAdapter, LlmMessage, LlmToolCall } from "@/agent/llm/types";
import { capCodeSnippets } from "@/agent/post/code-snippet-cap";
import { loadCodeSnippetCapOptions } from "@/agent/post/load-options";
import { buildSystemPrefix, NO_PROMPT_CAPABILITIES, type PromptCapabilities } from "@/agent/prompt";
import { loadPrompts } from "@/agent/prompt-loader";
import { buildToolRegistry } from "@/agent/tools/registry";
import type { AgentTool, ToolContext, ToolResult } from "@/agent/tools/types";
import type {
  ConversationId,
  ItemKind,
  MessageId,
  ProjectId,
  ProviderItemId,
  UserId,
} from "@/core/types";
import type { Db } from "@/db";
import { conversations, items, messages } from "@/db/schema";
import type { Conversation, Message } from "@/db/schema/types";
import { getBudgetStatus } from "@/server/billing/budget";
import { compactConversation, loadCompactionSettings } from "@/server/conversations/compaction";
import { appendMessage, getConversation } from "@/server/conversations/storage";
import { loadGuardrailSettings } from "@/server/guardrail/settings";
import { logger } from "@/server/logger";
import { getProviderSpec } from "@/server/provider-registry";
import { loadUserSetting } from "@/server/settings/effective";

type Database = Db;

// Tool-result envelopes the loop forwards to the SSE stream. Mirrors the
// shapes returned by `proposalResult` (mutating tools) and the
// `ask_user_question` tool — parsed defensively at the boundary so a
// schema drift in a mutating tool surfaces here instead of a malformed
// SSE event reaching the browser.
const PROPOSAL_TOOL_NAMES = [
  "propose_transition",
  "propose_description_patch",
  "propose_comment",
  "propose_new_item",
  "propose_item_tags",
] as const;
type ProposalToolName = (typeof PROPOSAL_TOOL_NAMES)[number];

const proposalStagedPayloadSchema = z
  .object({
    proposal_id: z.string(),
    kind: z.string().optional(),
  })
  .passthrough();

const askUserQuestionPayloadSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).nullable().optional(),
  multi_select: z.boolean().optional(),
});

function isProposalToolName(name: string): name is ProposalToolName {
  return PROPOSAL_TOOL_NAMES.some((n) => n === name);
}

export type LoopEvent =
  | { kind: "text_delta"; delta: string }
  | {
      kind: "tool_call_started";
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { kind: "tool_call_completed"; callId: string; ok: boolean }
  /**
   * Marks the end of one inner LLM round inside a multi-round turn. The
   * server emits this after a round's assistant text + tool calls have
   * been persisted and dispatched, just before the next round starts
   * streaming text. The browser uses it to snapshot the round into a
   * settled-rounds list so the next round's text deltas don't get
   * appended to the previous round's bubble.
   */
  | { kind: "round_boundary" }
  | { kind: "proposal_staged"; proposalId: string; proposalKind: string; toolName: string }
  | {
      kind: "ask_user_question";
      question: string;
      options: readonly string[] | null;
      multiSelect: boolean;
    }
  | {
      kind: "guardrail_blocked";
      stage: "input" | "tool_result" | "output";
      reason: string;
      categories?: readonly string[];
    }
  | {
      kind: "guardrail_flagged";
      stage: "input" | "tool_result" | "output";
      reason: string;
      categories?: readonly string[];
    }
  | {
      kind: "guardrail_usage";
      tokensIn: number;
      tokensOut: number;
      costCents: number | undefined;
    }
  | { kind: "usage"; tokensIn: number; tokensOut: number; costCents: number | undefined }
  | { kind: "done" }
  | { kind: "error"; message: string };

export type RunTurnArgs = {
  db: Database;
  adapter: LlmAdapter;
  conversationId: ConversationId;
  userId: UserId;
  userMessage: string;
  /** Read-only mode strips mutating tools from the registry. */
  readOnly: boolean;
  /** Optional override of the iteration cap, mainly for tests. */
  maxToolRounds?: number;
  /**
   * Aborts the LLM request when the caller goes away. The SSE route forwards
   * `req.signal` here so closing the browser tab stops billing tokens.
   */
  signal?: AbortSignal;
};

/**
 * Run one user → assistant exchange end to end.
 *
 * Yields a stream of `LoopEvent`s; consumers (the SSE handler, tests)
 * iterate until `done` or `error`. Errors are yielded as the final
 * event — the loop never throws.
 */
export async function* runTurn(args: RunTurnArgs): AsyncGenerator<LoopEvent> {
  const { db, adapter, conversationId, userId, userMessage, readOnly, signal } = args;
  // Per-user cap from the settings catalog. The override path (tests, future
  // admin tooling) wins so a misconfigured user setting can't lock the loop
  // out of an explicit caller intent.
  const cap = args.maxToolRounds ?? (await loadUserSetting(db, userId, "chat.max-tool-rounds"));
  const turnId = randomUUID();
  const turnStartedAt = Date.now();

  // 1. Load the conversation + project so we can build the prompt prefix
  //    and the per-project tool registry.
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    with: { project: true },
  });
  if (!conv) {
    logger.warn({ turnId, conversationId, userId }, "agent: conversation not found");
    yield { kind: "error", message: `conversation '${conversationId}' not found` };
    return;
  }
  const projectId = conv.projectId;

  const baseCtx: LoopContext = {
    turnId,
    conversationId,
    projectId,
    userId,
    adapter: adapter.kind,
    readOnly,
    userMessageLen: userMessage.length,
  };
  logger.info(baseCtx, "agent: turn start");

  // 2. Cost-cap check. The deployment-wide monthly LLM budget is enforced
  //    here so neither the SSE handler nor any future caller can bypass it.
  //    `block` refuses the turn outright; `warn` lets it through (the chat
  //    pane surfaces the banner from the same status query).
  const budget = await getBudgetStatus(db);
  if (budget.capReached && budget.action === "block") {
    logger.warn(
      {
        ...baseCtx,
        monthCents: budget.monthCents,
        capCents: budget.capCents,
      },
      "agent: turn blocked by budget cap",
    );
    yield {
      kind: "error",
      message: `monthly LLM cost cap reached (${(budget.monthCents / 100).toFixed(2)} of ${(budget.capCents / 100).toFixed(2)} USD); contact your deployment admin`,
    };
    return;
  }

  // 3. Persist the user message before we start streaming. If the LLM
  //    crashes mid-turn the row stays — the user can see what they sent
  //    and retry, no double-post.
  const userMessageRow = await appendMessage(db, {
    conversationId,
    role: "user",
    content: userMessage,
  });

  // 3a. Build the guardrail. Loaded per-turn (cheap — couple of setting
  //     reads + one optional LlmProvider lookup) so config edits during a
  //     long session take effect without reconnecting. A guardrail call
  //     that throws or times out is allowed-by-default inside the adapter
  //     itself — failures are silent, not turn-aborting.
  const guardrailSettings = await loadGuardrailSettings(db, projectId);
  const guardrail = await selectGuardrailFor(db, {
    project: conv.project,
    settings: guardrailSettings,
  });
  const guardrailUsage: GuardrailUsage = { tokensIn: 0, tokensOut: 0, costCents: 0 };

  // 3b. Input scope / safety check. A `block` aborts before we ever call
  //     the chat model — no tokens billed, no streaming. A `flag` is a
  //     soft warning surfaced to the UI; the turn proceeds.
  const inputDecision = await guardrail.checkInput(userMessage, signal);
  accumulateGuardrailUsage(guardrailUsage, inputDecision.usage);
  if (inputDecision.action !== "allow") {
    await markMessageFlagged(db, userMessageRow.id, inputDecision.reason);
    yield {
      kind: inputDecision.action === "block" ? "guardrail_blocked" : "guardrail_flagged",
      stage: "input",
      reason: inputDecision.reason,
      ...(inputDecision.categories ? { categories: inputDecision.categories } : {}),
    };
    if (inputDecision.action === "block") {
      logger.info(
        { ...baseCtx, reason: inputDecision.reason },
        "agent: input blocked by guardrail",
      );
      await persistAssistantTurn(db, conversationId, refusalText(inputDecision.reason), [], false);
      await flushGuardrailUsage(db, conversationId, guardrailUsage);
      if (guardrailUsage.tokensIn > 0 || guardrailUsage.tokensOut > 0) {
        yield {
          kind: "guardrail_usage",
          tokensIn: guardrailUsage.tokensIn,
          tokensOut: guardrailUsage.tokensOut,
          costCents: guardrailUsage.costCents,
        };
      }
      yield { kind: "done" };
      return;
    }
  }

  // 2a. Auto-compaction. Runs before transcript assembly so the prompt
  //     this turn already reflects the trimmed history. The compaction
  //     module no-ops when the transcript is below the project's
  //     configured threshold or the toggle is off.
  const compactionSettings = await loadCompactionSettings(db, projectId);
  if (compactionSettings.enabled) {
    const compaction = await compactConversation(db, conversationId, compactionSettings);
    if (compaction.compactedCount > 0) {
      logger.info(
        {
          ...baseCtx,
          strategy: compactionSettings.strategy,
          compactedCount: compaction.compactedCount,
          tokensBefore: compaction.tokensBefore,
          tokensAfter: compaction.tokensAfter,
        },
        "agent: compaction ran",
      );
    }
  }

  // 3. Build prompt prefix and tool registry. Both must be byte-stable
  //    across turns for the prompt cache to hit. One DB roundtrip pulls
  //    every Item field we need (summary text + kind + providerItemId).
  const itemContext = await loadItemContext(db, conv);
  const prompts = await loadPrompts(db);
  const promptCapabilities: PromptCapabilities = (() => {
    const spec = getProviderSpec(conv.project.providerKind);
    if (!spec) return NO_PROMPT_CAPABILITIES;
    return { pullRequestDiffs: spec.capabilities.pullRequestDiffs };
  })();
  const systemPrefix = buildSystemPrefix({
    itemKind: itemContext.kind,
    itemSummary: itemContext.summary,
    prompts,
    capabilities: promptCapabilities,
    maxToolRounds: cap,
  });

  const toolCtx: ToolContext = {
    db,
    projectId,
    userId,
    itemId: conv.itemId,
    providerItemId: itemContext.providerItemId,
  };
  const tools = await buildToolRegistry(toolCtx, { readOnly });

  // Load the project's code-snippet caps once per turn. Edits during a
  // long session take effect on the next turn, never mid-stream — the
  // cap runs on the assembled buffer, after the deltas have streamed.
  const codeSnippetCapOptions = await loadCodeSnippetCapOptions(db, projectId);

  const toolByName = new Map<string, AgentTool>();
  for (const t of tools) toolByName.set(t.def.name, t);

  // 4. Drive the streaming loop. We keep the running message list so we
  //    can append assistant + tool turns and re-call the adapter.
  const transcript = await loadTranscriptForLlm(db, conversationId);
  const messages: LlmMessage[] = [{ role: "system", content: systemPrefix }, ...transcript];

  let assistantBuffer = "";
  let assistantToolCalls: LlmToolCall[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostCents: number | undefined;
  let askedQuestion = false;
  let guardrailTerminated = false;
  let finalAssistantRow: Message | null = null;
  let rounds = 0;

  while (true) {
    rounds += 1;
    if (rounds > cap) {
      logger.warn(
        { ...baseCtx, rounds, cap, durationMs: Date.now() - turnStartedAt },
        "agent: tool-call cap exceeded",
      );
      yield {
        kind: "error",
        message: `agent loop exceeded ${cap} tool-call rounds; aborting`,
      };
      return;
    }

    const roundStartedAt = Date.now();
    const round = yield* streamOneRound(adapter, messages, tools, signal, baseCtx, rounds);
    assistantBuffer = round.assistantBuffer;
    assistantToolCalls = round.toolCalls;
    if (round.kind !== "ok") {
      logger.error(
        {
          ...baseCtx,
          round: rounds,
          roundMs: Date.now() - roundStartedAt,
          ...(round.kind === "error" ? { llmError: round.message } : {}),
        },
        round.kind === "error" ? "agent: LLM stream error" : "agent: LLM stream ended without done",
      );
      await persistAssistantTurn(db, conversationId, assistantBuffer, assistantToolCalls, false);
      yield {
        kind: "error",
        message: round.kind === "error" ? round.message : "LLM stream ended without a done event",
      };
      return;
    }
    totalTokensIn += round.tokensIn;
    totalTokensOut += round.tokensOut;
    if (round.costCents > 0) totalCostCents = (totalCostCents ?? 0) + round.costCents;

    logger.debug(
      {
        ...baseCtx,
        round: rounds,
        roundMs: Date.now() - roundStartedAt,
        textLen: assistantBuffer.length,
        toolCalls: assistantToolCalls.length,
      },
      "agent: LLM round done",
    );

    // No tool calls → assistant is finished. Apply the deterministic
    // code-snippet cap on the assembled buffer (post-processor runs
    // after streaming so deltas on the wire stay untouched), then
    // persist the trimmed text. The output guardrail check below scans
    // the same trimmed text.
    if (assistantToolCalls.length === 0) {
      const capped = capCodeSnippets(assistantBuffer, codeSnippetCapOptions);
      assistantBuffer = capped.text;
      finalAssistantRow = await persistAssistantTurn(
        db,
        conversationId,
        assistantBuffer,
        assistantToolCalls,
        false,
      );
      break;
    }

    // Append the assistant turn (text + tool_calls) to the in-flight
    // transcript so the next round sees it.
    messages.push({
      role: "assistant",
      content: assistantBuffer,
      toolCalls: assistantToolCalls,
    });

    // Persist the assistant text + tool calls so the user can replay
    // the turn later. The tool result rows follow individually below.
    await persistAssistantTurn(db, conversationId, assistantBuffer, assistantToolCalls, false);

    // Dispatch each tool call in order. Some tools (ask_user_question)
    // hand the turn back to the user — when we hit one, drain remaining
    // tool calls (we still owe the model results) but do NOT loop again.
    for (const call of assistantToolCalls) {
      const outcome = yield* dispatchToolCall(
        call,
        toolByName,
        guardrail,
        guardrailUsage,
        adapter,
        db,
        conversationId,
        baseCtx,
        rounds,
        signal,
      );
      messages.push(outcome.resultMessage);
      if (outcome.blockReason !== null) {
        // Stop the model from being re-invoked: drain remaining tool
        // calls into the transcript above, then break out so the outer
        // loop never calls `streamMessages` again. Preserves the "model
        // doesn't keep generating after guardrail kicks in" invariant.
        guardrailTerminated = true;
      }
      if (outcome.askedQuestion) askedQuestion = true;
    }

    if (askedQuestion || guardrailTerminated) {
      // Either: (a) tool dispatched ask_user_question and we're handing
      // back, or (b) guardrail blocked a tool result and we refuse to
      // re-invoke the chat model on it. The corresponding final assistant
      // turn is already persisted; the UI shows it as the end of the turn.
      break;
    }

    // Round done, more rounds to come. Tell the client to snapshot the
    // round it's been showing live (text bubble + ToolCallProgress) into
    // its settled-rounds list and reset for the next round's deltas.
    yield { kind: "round_boundary" };
  }

  // Output-safety check on the final assistant text. Always non-blocking
  // (the user has already seen the streamed reply) — a `flag` marks the
  // row so the chat pane renders a banner. Skipped when the guardrail
  // already terminated the turn (the assistant text is a refusal stub
  // we wrote ourselves) or when the assistant ended with a question.
  if (
    !guardrailTerminated &&
    !askedQuestion &&
    finalAssistantRow &&
    assistantBuffer.trim().length > 0
  ) {
    const outputDecision = await guardrail.checkOutput(assistantBuffer, signal);
    accumulateGuardrailUsage(guardrailUsage, outputDecision.usage);
    if (outputDecision.action !== "allow") {
      await markMessageFlagged(db, finalAssistantRow.id, outputDecision.reason);
      yield {
        kind: "guardrail_flagged",
        stage: "output",
        reason: outputDecision.reason,
        ...(outputDecision.categories ? { categories: outputDecision.categories } : {}),
      };
    }
  }

  if (totalTokensIn > 0 || totalTokensOut > 0) {
    yield {
      kind: "usage",
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      costCents: totalCostCents,
    };
    await db
      .update(conversations)
      .set({
        tokensIn: sql`${conversations.tokensIn} + ${totalTokensIn}`,
        tokensOut: sql`${conversations.tokensOut} + ${totalTokensOut}`,
        ...(totalCostCents !== undefined
          ? { costCents: sql`${conversations.costCents} + ${totalCostCents}` }
          : {}),
      })
      .where(eq(conversations.id, conversationId));
  }

  await flushGuardrailUsage(db, conversationId, guardrailUsage);
  if (guardrailUsage.tokensIn > 0 || guardrailUsage.tokensOut > 0) {
    yield {
      kind: "guardrail_usage",
      tokensIn: guardrailUsage.tokensIn,
      tokensOut: guardrailUsage.tokensOut,
      costCents: guardrailUsage.costCents,
    };
  }

  logger.info(
    {
      ...baseCtx,
      rounds,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      costCents: totalCostCents,
      guardrailTokensIn: guardrailUsage.tokensIn,
      guardrailTokensOut: guardrailUsage.tokensOut,
      guardrailCostCents: guardrailUsage.costCents,
      askedQuestion,
      guardrailTerminated,
      durationMs: Date.now() - turnStartedAt,
    },
    "agent: turn done",
  );
  yield { kind: "done" };
}

// ---------------------------------------------------------------------------
// helpers — small, kept private to the loop module
// ---------------------------------------------------------------------------

type LoopContext = {
  turnId: string;
  conversationId: ConversationId;
  projectId: ProjectId;
  userId: UserId;
  adapter: string;
  readOnly: boolean;
  userMessageLen: number;
};

type RoundOutcome =
  | {
      kind: "ok";
      assistantBuffer: string;
      toolCalls: LlmToolCall[];
      tokensIn: number;
      tokensOut: number;
      costCents: number;
    }
  | { kind: "error"; message: string; assistantBuffer: string; toolCalls: LlmToolCall[] }
  | { kind: "no_done"; assistantBuffer: string; toolCalls: LlmToolCall[] };

/**
 * Stream one LLM round. Yields `text_delta` events as they arrive and
 * accumulates the assembled buffer + tool calls + usage into the return
 * value. The caller decides how to react to a non-ok outcome (persisting
 * partial output, emitting an `error` event, etc.).
 */
async function* streamOneRound(
  adapter: LlmAdapter,
  messages: readonly LlmMessage[],
  tools: readonly AgentTool[],
  signal: AbortSignal | undefined,
  baseCtx: LoopContext,
  round: number,
): AsyncGenerator<LoopEvent, RoundOutcome> {
  const stream = adapter.streamMessages({
    model: "", // adapter falls back to its configured model
    messages: [...messages],
    tools: tools.map((t) => t.def),
    ...(signal ? { signal } : {}),
  });
  let assistantBuffer = "";
  const toolCalls: LlmToolCall[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let costCents = 0;
  let sawDone = false;
  for await (const event of stream) {
    switch (event.kind) {
      case "text_delta":
        assistantBuffer += event.delta;
        yield { kind: "text_delta", delta: event.delta };
        break;
      case "tool_call":
        toolCalls.push(event.call);
        break;
      case "usage":
        tokensIn += event.tokensIn;
        tokensOut += event.tokensOut;
        costCents += event.costCents ?? 0;
        break;
      case "error":
        return { kind: "error", message: event.message, assistantBuffer, toolCalls };
      case "done":
        sawDone = true;
        break;
      default: {
        const exhaustive: never = event;
        logger.error({ ...baseCtx, round, event: exhaustive }, "agent: unhandled LLM event kind");
      }
    }
    if (sawDone) break;
  }
  if (!sawDone) return { kind: "no_done", assistantBuffer, toolCalls };
  return { kind: "ok", assistantBuffer, toolCalls, tokensIn, tokensOut, costCents };
}

type ToolDispatchOutcome = {
  /** The formatted tool-result message that the caller appends to the in-flight transcript. */
  resultMessage: LlmMessage;
  /** Non-null when the guardrail blocked the result; carries the reason. */
  blockReason: string | null;
  /** True when the dispatched tool was `ask_user_question`. */
  askedQuestion: boolean;
};

/**
 * Dispatch one tool call: execute the tool, run the guardrail tool-result
 * scan, persist the tool row, and yield the lifecycle events. Mutates
 * `guardrailUsage` in place with any usage burnt by the scan.
 */
async function* dispatchToolCall(
  call: LlmToolCall,
  toolByName: ReadonlyMap<string, AgentTool>,
  guardrail: Guardrail,
  guardrailUsage: GuardrailUsage,
  adapter: LlmAdapter,
  db: Database,
  conversationId: ConversationId,
  baseCtx: LoopContext,
  round: number,
  signal: AbortSignal | undefined,
): AsyncGenerator<LoopEvent, ToolDispatchOutcome> {
  yield {
    kind: "tool_call_started",
    callId: call.id,
    name: call.name,
    arguments: call.arguments,
  };

  const tool = toolByName.get(call.name);
  let result: ToolResult;
  let dispatchOk = true;
  const toolStartedAt = Date.now();
  if (!tool) {
    result = { ok: false, error: `unknown tool '${call.name}'` };
    dispatchOk = false;
    logger.warn(
      { ...baseCtx, round, callId: call.id, name: call.name },
      "agent: unknown tool requested",
    );
  } else {
    try {
      result = await tool.handler(call.arguments);
    } catch (err) {
      result = {
        ok: false,
        error: `tool '${call.name}' threw: ${err instanceof Error ? err.message : String(err)}`,
      };
      dispatchOk = false;
      logger.error(
        {
          ...baseCtx,
          round,
          callId: call.id,
          name: call.name,
          toolMs: Date.now() - toolStartedAt,
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        "agent: tool threw",
      );
    }
  }
  // Tools that catch internally and return `fail()` don't throw — without
  // the explicit envelope check we'd render a ✗ outcome as ✓ in the UI
  // and miss every guarded provider error in the logs.
  if (dispatchOk && !result.ok) {
    dispatchOk = false;
    logger.warn(
      {
        ...baseCtx,
        round,
        callId: call.id,
        name: call.name,
        toolMs: Date.now() - toolStartedAt,
        toolError: result.error,
      },
      "agent: tool returned failure",
    );
  } else {
    logger.debug(
      {
        ...baseCtx,
        round,
        callId: call.id,
        name: call.name,
        ok: dispatchOk,
        toolMs: Date.now() - toolStartedAt,
      },
      "agent: tool call",
    );
  }

  // Guardrail tool-result scan. Runs on the structured payload before
  // it's re-fed to the model — a `block` substitutes a refusal stub
  // (the model never sees the original text) and aborts the round so
  // the chat model doesn't keep generating off injected instructions.
  //
  // Tools tagged `guardrailScan: { mode: "skip" }` short-circuit here:
  // their results are server-generated metadata only (proposal ids,
  // echoed question text), so the LLM judge would just be flipping a
  // coin on an opaque JSON envelope and occasionally producing
  // false-positive blocks. No call, no usage accounting, no event.
  //
  // `mode: "fields"` extracts the listed dotted paths from
  // `result.data` and hands the guardrail a focused string of just the
  // foreign content (markdown body, comment text, diff). Empty
  // extraction short-circuits the same way `skip` does — the result
  // had no untrusted text to scan.
  let blockReason: string | null = null;
  const scan = tool?.guardrailScan ?? { mode: "full" };
  let runGuardrail = scan.mode !== "skip";
  let untrusted: string | undefined;
  if (scan.mode === "fields") {
    untrusted = extractUntrustedFields(result, scan.untrusted);
    if (untrusted.length === 0) runGuardrail = false;
  }
  if (runGuardrail) {
    const toolDecision = await guardrail.checkToolResult(
      {
        toolName: call.name,
        result,
        ...(untrusted !== undefined ? { untrusted } : {}),
      },
      signal,
    );
    accumulateGuardrailUsage(guardrailUsage, toolDecision.usage);
    if (toolDecision.action === "block") {
      blockReason = toolDecision.reason;
      result = {
        ok: false,
        error: `tool result blocked by guardrail: ${toolDecision.reason}`,
      };
      yield {
        kind: "guardrail_blocked",
        stage: "tool_result",
        reason: toolDecision.reason,
        ...(toolDecision.categories ? { categories: toolDecision.categories } : {}),
      };
      logger.info(
        { ...baseCtx, round, callId: call.id, reason: toolDecision.reason },
        "agent: tool result blocked by guardrail",
      );
    } else if (toolDecision.action === "flag") {
      yield {
        kind: "guardrail_flagged",
        stage: "tool_result",
        reason: toolDecision.reason,
        ...(toolDecision.categories ? { categories: toolDecision.categories } : {}),
      };
    }
  }

  const formatted = adapter.formatToolResult(call, result);
  const toolRow = await appendMessage(db, {
    conversationId,
    role: "tool",
    content: formatted.content,
    toolCallId: formatted.toolCallId,
    toolName: formatted.toolName,
  });
  if (blockReason !== null) {
    await markMessageFlagged(db, toolRow.id, blockReason);
    // Surface the block to the user as a final assistant turn so the
    // chat thread shows *why* the agent stopped instead of trailing
    // off mid-thought. Pinned at the end of this round; the outer
    // while-loop bails before the next stream starts.
    await persistAssistantTurn(db, conversationId, refusalText(blockReason), [], false);
  }

  yield { kind: "tool_call_completed", callId: call.id, ok: dispatchOk };

  let askedQuestion = false;
  if (blockReason === null) {
    // Special-case the two structured tool payloads the UI cares about.
    if (result.ok && isProposalToolName(call.name)) {
      const parsed = proposalStagedPayloadSchema.safeParse(result.data);
      if (parsed.success) {
        yield {
          kind: "proposal_staged",
          proposalId: parsed.data.proposal_id,
          proposalKind: parsed.data.kind ?? call.name,
          toolName: call.name,
        };
      }
    }
    if (result.ok && call.name === "ask_user_question") {
      const parsed = askUserQuestionPayloadSchema.safeParse(result.data);
      if (parsed.success) {
        askedQuestion = true;
        yield {
          kind: "ask_user_question",
          question: parsed.data.question,
          options: parsed.data.options ?? null,
          multiSelect: parsed.data.multi_select ?? false,
        };
      }
    }
  }

  return { resultMessage: formatted, blockReason, askedQuestion };
}

function accumulateGuardrailUsage(total: GuardrailUsage, add: GuardrailUsage | undefined): void {
  if (!add) return;
  total.tokensIn += add.tokensIn;
  total.tokensOut += add.tokensOut;
  if (add.costCents !== undefined) {
    total.costCents = (total.costCents ?? 0) + add.costCents;
  }
}

async function flushGuardrailUsage(
  db: Database,
  conversationId: ConversationId,
  usage: GuardrailUsage,
): Promise<void> {
  if (usage.tokensIn === 0 && usage.tokensOut === 0) return;
  await db
    .update(conversations)
    .set({
      guardrailTokensIn: sql`${conversations.guardrailTokensIn} + ${usage.tokensIn}`,
      guardrailTokensOut: sql`${conversations.guardrailTokensOut} + ${usage.tokensOut}`,
      ...(usage.costCents !== undefined && usage.costCents > 0
        ? {
            guardrailCostCents: sql`${conversations.guardrailCostCents} + ${Math.round(usage.costCents)}`,
          }
        : {}),
    })
    .where(eq(conversations.id, conversationId));
}

async function markMessageFlagged(
  db: Database,
  messageId: MessageId,
  reason: string,
): Promise<void> {
  await db
    .update(messages)
    .set({ flagged: true, guardrailReason: reason })
    .where(eq(messages.id, messageId));
}

/**
 * User-facing refusal copy. Internal guardrail labels (e.g.
 * "llm-judge: off-topic for ticketing-system assistant") are concise and
 * good for logs/metrics but read like an error code in chat. Map them to
 * a friendlier shell here. The full label is still recorded on
 * `Message.guardrailReason` for the banner above the bubble — the chat
 * UI surfaces both.
 */
function refusalText(reason: string): string {
  if (reason.startsWith("llm-judge: off-topic")) {
    return "Sorry — I can only help with software work-item topics. Try asking about a ticket, PR, or code question.";
  }
  if (reason.includes("prompt injection") || reason.includes("injection")) {
    return "I had to stop here — that tool result looked like it was trying to override my instructions. Ask me to retry, or check the source content.";
  }
  return "Sorry, I can't continue with that request.";
}

// Schema mirror of `LlmToolCall` for runtime validation of the JSON column.
// Persisted rows go through `appendMessage` from this process, but a
// `JsonValue` from Drizzle is structurally `unknown` at the type level and
// could carry data from an older schema if the row was rewritten by a
// different code path. Validate at the read boundary so a malformed entry
// surfaces as "drop this turn's tool calls" rather than as a downstream
// crash inside the dispatcher.
const ToolCallShape: z.ZodType<LlmToolCall> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});
const ToolCallsArrayShape = z.array(ToolCallShape);

function readToolCallsJson(raw: unknown): LlmToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const parsed = ToolCallsArrayShape.safeParse(raw);
  if (!parsed.success) return undefined;
  return parsed.data;
}

async function persistAssistantTurn(
  db: Database,
  conversationId: ConversationId,
  text: string,
  toolCalls: readonly LlmToolCall[],
  pending: boolean,
): Promise<Message> {
  return appendMessage(db, {
    conversationId,
    role: "assistant",
    content: text,
    // `LlmToolCall[]` carries `Record<string, unknown>` for its `arguments`
    // field, which Prisma's strict `InputJsonValue` won't accept directly —
    // round-trip through `object` (the `AppendArgs.toolCallsJson` shape) so
    // the boundary cast is a single up-and-down rather than `unknown`.
    toolCallsJson: toolCalls.length > 0 ? (toolCalls as readonly object[]) : null,
    pending,
  });
}

async function loadTranscriptForLlm(
  db: Database,
  conversationId: ConversationId,
): Promise<LlmMessage[]> {
  const conv = await getConversation(db, conversationId);
  if (!conv) return [];
  const out: LlmMessage[] = [];
  for (const m of conv.messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: m.content });
    } else if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      // `toolCallsJson` is the round-trip read of what `persistAssistantTurn`
      // wrote — Prisma's `JsonValue` typing erases the original `LlmToolCall[]`
      // shape, but the write shape is the only thing that lands here.
      const calls = readToolCallsJson(m.toolCallsJson);
      out.push({
        role: "assistant",
        content: m.content,
        ...(calls ? { toolCalls: calls } : {}),
      });
    } else if (m.role === "tool" && m.toolCallId && m.toolName) {
      out.push({
        role: "tool",
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        content: m.content,
      });
    }
  }
  return out;
}

type ItemContext = {
  summary: string | null;
  kind: ItemKind | null;
  providerItemId: ProviderItemId | null;
};

async function loadItemContext(db: Database, conv: Conversation): Promise<ItemContext> {
  if (!conv.itemId) {
    return { summary: null, kind: null, providerItemId: null };
  }
  const item = await db
    .select({
      providerItemId: items.providerItemId,
      kind: items.kind,
      title: items.title,
      state: items.state,
      assignees: items.assignees,
      createdAt: items.createdAt,
      updatedAt: items.updatedAt,
    })
    .from(items)
    .where(eq(items.id, conv.itemId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!item) return { summary: null, kind: null, providerItemId: null };
  const assignee = item.assignees[0] ?? null;
  // Dates are ISO YYYY-MM-DD: stable for the day so the prefix doesn't
  // churn between turns when nothing material changed, but still gives the
  // model a staleness signal it can compute against. Skipping the time
  // component is deliberate — minute-level updates on a sync would
  // invalidate the prompt cache for no semantic gain.
  const createdDate = item.createdAt ? toIsoDate(item.createdAt) : null;
  const updatedDate = toIsoDate(item.updatedAt);
  const lines = [
    `id: ${item.providerItemId}`,
    `kind: ${item.kind}`,
    `title: ${item.title}`,
    `state: ${item.state}`,
    assignee ? `assignee: ${assignee}` : "assignee: (unassigned)",
    createdDate ? `created: ${createdDate}` : "created: (unknown)",
    `updated: ${updatedDate}`,
  ];
  return {
    summary: lines.join("\n"),
    kind: item.kind,
    providerItemId: item.providerItemId,
  };
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
