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
  | { kind: "proposal_staged"; proposalId: string; proposalKind: string; toolName: string }
  | {
      kind: "ask_user_question";
      question: string;
      options: readonly string[] | null;
      multiSelect: boolean;
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
};

/**
 * Run one user → assistant exchange end to end.
 *
 * Yields a stream of `LoopEvent`s; consumers (the SSE handler, tests)
 * iterate until `done` or `error`. Errors are yielded as the final
 * event — the loop never throws.
 */
export async function* runTurn(args: RunTurnArgs): AsyncGenerator<LoopEvent> {
  const { db, adapter, conversationId, userId, userMessage, readOnly } = args;
  const cap = args.maxToolRounds ?? MAX_TOOL_ROUNDS;

  // 1. Load the conversation + project so we can build the prompt prefix
  //    and the per-project tool registry.
  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
    include: { project: true },
  });
  if (!conv) {
    yield { kind: "error", message: `conversation '${conversationId}' not found` };
    return;
  }

  // 2. Cost-cap check. The deployment-wide monthly LLM budget is enforced
  //    here so neither the SSE handler nor any future caller can bypass it.
  //    `block` refuses the turn outright; `warn` lets it through (the chat
  //    pane surfaces the banner from the same status query).
  const budget = await getBudgetStatus(db);
  if (budget.capReached && budget.action === "block") {
    yield {
      kind: "error",
      message: `monthly LLM cost cap reached (${(budget.monthCents / 100).toFixed(2)} of ${(budget.capCents / 100).toFixed(2)} USD); contact your deployment admin`,
    };
    return;
  }

  // 3. Persist the user message before we start streaming. If the LLM
  //    crashes mid-turn the row stays — the user can see what they sent
  //    and retry, no double-post.
  await appendMessage(db, {
    conversationId,
    role: "user",
    content: userMessage,
  });

  // 2a. Auto-compaction. Runs before transcript assembly so the prompt
  //     this turn already reflects the trimmed history. The compaction
  //     module no-ops when the transcript is below the project's
  //     configured threshold or the toggle is off.
  const compactionSettings = await loadCompactionSettings(db, conv.projectId);
  if (compactionSettings.enabled) {
    await compactConversation(db, conversationId, compactionSettings);
  }

  // 3. Build prompt prefix and tool registry. Both must be byte-stable
  //    across turns for the prompt cache to hit.
  const itemSummary = await loadItemSummary(db, conv);
  const itemKind = await loadItemKind(db, conv);
  const systemPrefix = buildSystemPrefix({ itemKind, itemSummary });

  const toolCtx: ToolContext = {
    db,
    projectId: conv.projectId,
    userId,
    itemId: conv.itemId,
    providerItemId: conv.itemId
      ? ((
          await db.item.findUnique({ where: { id: conv.itemId }, select: { providerItemId: true } })
        )?.providerItemId ?? null)
      : null,
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
  let rounds = 0;

  while (true) {
    rounds += 1;
    if (rounds > cap) {
      yield {
        kind: "error",
        message: `agent loop exceeded ${cap} tool-call rounds; aborting`,
      };
      return;
    }

    assistantBuffer = "";
    assistantToolCalls = [];

    const stream = adapter.streamMessages({
      model: "", // adapter falls back to its configured model
      messages,
      tools: tools.map((t) => t.def),
    });

    let sawDone = false;
    for await (const event of stream as AsyncIterable<LlmEvent>) {
      if (event.kind === "text_delta") {
        assistantBuffer += event.delta;
        yield { kind: "text_delta", delta: event.delta };
      } else if (event.kind === "tool_call") {
        assistantToolCalls.push(event.call);
      } else if (event.kind === "usage") {
        totalTokensIn += event.tokensIn;
        totalTokensOut += event.tokensOut;
        totalCostCents = (totalCostCents ?? 0) + (event.costCents ?? 0);
      } else if (event.kind === "error") {
        await persistAssistantTurn(db, conversationId, assistantBuffer, assistantToolCalls, false);
        yield { kind: "error", message: event.message };
        return;
      } else if (event.kind === "done") {
        sawDone = true;
        break;
      }
    }

    if (!sawDone) {
      yield { kind: "error", message: "LLM stream ended without a done event" };
      return;
    }

    // No tool calls → assistant is finished. Persist + emit final events.
    if (assistantToolCalls.length === 0) {
      await persistAssistantTurn(db, conversationId, assistantBuffer, assistantToolCalls, false);
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
      if (!tool) {
        result = { ok: false, error: `unknown tool '${call.name}'` };
        dispatchOk = false;
      } else {
        try {
          result = await tool.handler(call.arguments);
        } catch (err) {
          result = {
            ok: false,
            error: `tool '${call.name}' threw: ${err instanceof Error ? err.message : String(err)}`,
          };
          dispatchOk = false;
        }
      }

      const formatted = adapter.formatToolResult(call, result);
      messages.push(formatted);

      await appendMessage(db, {
        conversationId,
        role: "tool",
        content: formatted.content,
        toolCallId: formatted.toolCallId,
        toolName: formatted.toolName,
      });

      yield { kind: "tool_call_completed", callId: call.id, ok: dispatchOk };

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

    if (askedQuestion) {
      // Hand back to the user. The question is already persisted as the
      // last assistant turn; the UI marks it pending until they reply.
      break;
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

  yield { kind: "done" };
}

// ---------------------------------------------------------------------------
// helpers — small, kept private to the loop module
// ---------------------------------------------------------------------------

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

async function loadItemSummary(db: Database, conv: Conversation): Promise<string | null> {
  if (!conv.itemId) return null;
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
  if (!item) return null;
  const lines = [
    `id: ${item.providerItemId}`,
    `kind: ${item.kind}`,
    `title: ${item.title}`,
    `state: ${item.state}`,
    item.assignee ? `assignee: ${item.assignee}` : "assignee: (unassigned)",
  ];
  return lines.join("\n");
}

async function loadItemKind(db: Database, conv: Conversation): Promise<ItemKind | null> {
  if (!conv.itemId) return null;
  const item = await db.item.findUnique({
    where: { id: conv.itemId },
    select: { kind: true },
  });
  if (!item) return null;
  return item.kind as ItemKind;
}
