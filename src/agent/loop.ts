/**
 * Streaming agent loop.
 *
 * One call to `runTurn()` handles a complete user → assistant exchange:
 * persist the user message, ask the LLM for a response, dispatch any tool
 * calls it requests, re-feed the results, and finally persist the
 * assistant message. Yields a vendor-neutral stream of `LoopEvent`s the
 * SSE handler in `src/app/api/.../route.ts` serializes to the browser.
 *
 * Three invariants the loop preserves:
 *   1. **Prompt prefix is byte-stable.** `buildSystemPrefix` produces the
 *      same string for the same `(itemKind, itemSummary)` tuple. The
 *      tool list comes from `buildToolRegistry`, whose order is pinned
 *      by an arch test. OpenAI's automatic prompt cache hits on
 *      ≥1024-token deterministic prefixes — that's the property we're
 *      protecting.
 *   2. **Tool calls are dispatched, not echoed back.** The loop never
 *      returns control to the caller mid-turn; it iterates internally
 *      until the adapter emits `done` or hits the hard tool-round cap.
 *   3. **`ask_user_question` ends the turn early.** Dispatch returns the
 *      structured payload; the loop emits `ask_user_question`,
 *      persists the assistant message with `pending: true`, and yields
 *      `done` without re-feeding. The next user message lands as a
 *      regular `user` row and a fresh `runTurn()` resumes from there.
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { selectGuardrailFor } from "@/agent/guardrail/registry";
import type { GuardrailUsage } from "@/agent/guardrail/types";
import type { LlmAdapter, LlmEvent, LlmMessage, LlmToolCall } from "@/agent/llm/types";
import { buildSystemPrefix } from "@/agent/prompt";
import { buildToolRegistry } from "@/agent/tools/registry";
import type { AgentTool, ToolContext } from "@/agent/tools/types";
import type { ItemKind } from "@/core/types";
import type { Conversation, Message } from "@/db/generated/client";
import { getBudgetStatus } from "@/server/billing/budget";
import { compactConversation, loadCompactionSettings } from "@/server/conversations/compaction";
import { appendMessage, getConversation } from "@/server/conversations/storage";
import type { db as Db } from "@/server/db";
import { loadGuardrailSettings } from "@/server/guardrail/settings";
import { logger } from "@/server/logger";

type Database = typeof Db;

/** Hard cap on tool-call rounds within a single user turn. */
const MAX_TOOL_ROUNDS = 8;

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
  conversationId: string;
  userId: string;
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
  const cap = args.maxToolRounds ?? MAX_TOOL_ROUNDS;
  const turnId = randomUUID();
  const turnStartedAt = Date.now();

  // 1. Load the conversation + project so we can build the prompt prefix
  //    and the per-project tool registry.
  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
    include: { project: true },
  });
  if (!conv) {
    logger.warn({ turnId, conversationId, userId }, "agent: conversation not found");
    yield { kind: "error", message: `conversation '${conversationId}' not found` };
    return;
  }

  const baseCtx = {
    turnId,
    conversationId,
    projectId: conv.projectId,
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
  const guardrailSettings = await loadGuardrailSettings(db, conv.projectId);
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
  const compactionSettings = await loadCompactionSettings(db, conv.projectId);
  if (compactionSettings.enabled) {
    await compactConversation(db, conversationId, compactionSettings);
  }

  // 3. Build prompt prefix and tool registry. Both must be byte-stable
  //    across turns for the prompt cache to hit. One DB roundtrip pulls
  //    every Item field we need (summary text + kind + providerItemId).
  const itemContext = await loadItemContext(db, conv);
  const systemPrefix = buildSystemPrefix({
    itemKind: itemContext.kind,
    itemSummary: itemContext.summary,
  });

  const toolCtx: ToolContext = {
    db,
    projectId: conv.projectId,
    userId,
    itemId: conv.itemId,
    providerItemId: itemContext.providerItemId,
  };
  const tools = await buildToolRegistry(toolCtx, { readOnly });

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

    assistantBuffer = "";
    assistantToolCalls = [];
    const roundStartedAt = Date.now();

    const stream = adapter.streamMessages({
      model: "", // adapter falls back to its configured model
      messages,
      tools: tools.map((t) => t.def),
      ...(signal ? { signal } : {}),
    });

    let sawDone = false;
    for await (const event of stream as AsyncIterable<LlmEvent>) {
      switch (event.kind) {
        case "text_delta":
          assistantBuffer += event.delta;
          yield { kind: "text_delta", delta: event.delta };
          break;
        case "tool_call":
          assistantToolCalls.push(event.call);
          break;
        case "usage":
          totalTokensIn += event.tokensIn;
          totalTokensOut += event.tokensOut;
          totalCostCents = (totalCostCents ?? 0) + (event.costCents ?? 0);
          break;
        case "error":
          logger.error(
            {
              ...baseCtx,
              round: rounds,
              roundMs: Date.now() - roundStartedAt,
              llmError: event.message,
            },
            "agent: LLM stream error",
          );
          await persistAssistantTurn(
            db,
            conversationId,
            assistantBuffer,
            assistantToolCalls,
            false,
          );
          yield { kind: "error", message: event.message };
          return;
        case "done":
          sawDone = true;
          break;
        default: {
          // Compile-time exhaustiveness check — adding a new LlmEvent kind
          // forces a case here rather than silently dropping the event.
          const exhaustive: never = event;
          logger.error(
            { ...baseCtx, round: rounds, event: exhaustive as unknown },
            "agent: unhandled LLM event kind",
          );
        }
      }
      if (sawDone) break;
    }

    if (!sawDone) {
      logger.error(
        { ...baseCtx, round: rounds, roundMs: Date.now() - roundStartedAt },
        "agent: LLM stream ended without done",
      );
      yield { kind: "error", message: "LLM stream ended without a done event" };
      return;
    }

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

    // No tool calls → assistant is finished. Persist + emit final events.
    if (assistantToolCalls.length === 0) {
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
      yield {
        kind: "tool_call_started",
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
      };

      const tool = toolByName.get(call.name);
      let result: unknown;
      let dispatchOk = true;
      const toolStartedAt = Date.now();
      if (!tool) {
        result = { ok: false, error: `unknown tool '${call.name}'` };
        dispatchOk = false;
        logger.warn(
          { ...baseCtx, round: rounds, callId: call.id, name: call.name },
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
              round: rounds,
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
      logger.debug(
        {
          ...baseCtx,
          round: rounds,
          callId: call.id,
          name: call.name,
          ok: dispatchOk,
          toolMs: Date.now() - toolStartedAt,
        },
        "agent: tool call",
      );

      // Guardrail tool-result scan. Runs on the structured payload before
      // it's re-fed to the model — a `block` substitutes a refusal stub
      // (the model never sees the original text) and aborts the round so
      // the chat model doesn't keep generating off injected instructions.
      let toolBlockReason: string | null = null;
      const toolDecision = await guardrail.checkToolResult({ toolName: call.name, result }, signal);
      accumulateGuardrailUsage(guardrailUsage, toolDecision.usage);
      if (toolDecision.action === "block") {
        toolBlockReason = toolDecision.reason;
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
          { ...baseCtx, round: rounds, callId: call.id, reason: toolDecision.reason },
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

      const formatted = adapter.formatToolResult(call, result);
      messages.push(formatted);

      const toolRow = await appendMessage(db, {
        conversationId,
        role: "tool",
        content: formatted.content,
        toolCallId: formatted.toolCallId,
        toolName: formatted.toolName,
      });
      if (toolBlockReason !== null) {
        await markMessageFlagged(db, toolRow.id, toolBlockReason);
        // Surface the block to the user as a final assistant turn so the
        // chat thread shows *why* the agent stopped instead of trailing
        // off mid-thought. Pinned at the end of this round; the outer
        // while-loop bails before the next stream starts.
        await persistAssistantTurn(db, conversationId, refusalText(toolBlockReason), [], false);
      }

      yield { kind: "tool_call_completed", callId: call.id, ok: dispatchOk };

      if (toolBlockReason !== null) {
        // Stop the model from being re-invoked: drain remaining tool
        // calls into the transcript above, then break out so the outer
        // loop never calls `streamMessages` again. Preserves the "model
        // doesn't keep generating after guardrail kicks in" invariant.
        guardrailTerminated = true;
        continue;
      }

      // Special-case the two structured tool payloads the UI cares about.
      const data = (result as { ok?: boolean; data?: unknown }).data;
      if (data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        if (
          (call.name === "propose_transition" ||
            call.name === "propose_description_patch" ||
            call.name === "propose_comment" ||
            call.name === "propose_new_item") &&
          typeof d.proposalId === "string"
        ) {
          yield {
            kind: "proposal_staged",
            proposalId: d.proposalId,
            proposalKind: typeof d.kind === "string" ? d.kind : call.name,
            toolName: call.name,
          };
        }
        if (call.name === "ask_user_question" && typeof d.question === "string") {
          askedQuestion = true;
          yield {
            kind: "ask_user_question",
            question: d.question,
            options: Array.isArray(d.options) ? (d.options as string[]) : null,
            multiSelect: Boolean(d.multiSelect),
          };
        }
      }
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
    await db.conversation.update({
      where: { id: conversationId },
      data: {
        tokensIn: { increment: totalTokensIn },
        tokensOut: { increment: totalTokensOut },
        ...(totalCostCents !== undefined ? { costCents: { increment: totalCostCents } } : {}),
      },
    });
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
  conversationId: string,
  usage: GuardrailUsage,
): Promise<void> {
  if (usage.tokensIn === 0 && usage.tokensOut === 0) return;
  await db.conversation.update({
    where: { id: conversationId },
    data: {
      guardrailTokensIn: { increment: usage.tokensIn },
      guardrailTokensOut: { increment: usage.tokensOut },
      ...(usage.costCents !== undefined && usage.costCents > 0
        ? { guardrailCostCents: { increment: Math.round(usage.costCents) } }
        : {}),
    },
  });
}

async function markMessageFlagged(db: Database, messageId: string, reason: string): Promise<void> {
  await db.message.update({
    where: { id: messageId },
    data: { flagged: true, guardrailReason: reason },
  });
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
  if (reason.startsWith("llm-judge: off-topic") || reason.startsWith("pattern: off-topic")) {
    return "Sorry — I can only help with software work-item topics. Try asking about a ticket, PR, or code question.";
  }
  if (reason.includes("prompt injection") || reason.includes("injection")) {
    return "I had to stop here — that tool result looked like it was trying to override my instructions. Ask me to retry, or check the source content.";
  }
  return "Sorry, I can't continue with that request.";
}

async function persistAssistantTurn(
  db: Database,
  conversationId: string,
  text: string,
  toolCalls: readonly LlmToolCall[],
  pending: boolean,
): Promise<Message> {
  return appendMessage(db, {
    conversationId,
    role: "assistant",
    content: text,
    toolCallsJson:
      toolCalls.length > 0 ? (toolCalls as unknown as Record<string, unknown>[]) : null,
    pending,
  });
}

async function loadTranscriptForLlm(db: Database, conversationId: string): Promise<LlmMessage[]> {
  const conv = await getConversation(db, conversationId);
  if (!conv) return [];
  const out: LlmMessage[] = [];
  for (const m of conv.messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: m.content });
    } else if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const calls =
        Array.isArray(m.toolCallsJson) && m.toolCallsJson.length > 0
          ? (m.toolCallsJson as unknown as LlmToolCall[])
          : undefined;
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
  providerItemId: string | null;
};

async function loadItemContext(db: Database, conv: Conversation): Promise<ItemContext> {
  if (!conv.itemId) {
    return { summary: null, kind: null, providerItemId: null };
  }
  const item = await db.item.findUnique({
    where: { id: conv.itemId },
    select: {
      providerItemId: true,
      kind: true,
      title: true,
      state: true,
      assignee: true,
    },
  });
  if (!item) return { summary: null, kind: null, providerItemId: null };
  const lines = [
    `id: ${item.providerItemId}`,
    `kind: ${item.kind}`,
    `title: ${item.title}`,
    `state: ${item.state}`,
    item.assignee ? `assignee: ${item.assignee}` : "assignee: (unassigned)",
  ];
  return {
    summary: lines.join("\n"),
    kind: item.kind as ItemKind,
    providerItemId: item.providerItemId,
  };
}
