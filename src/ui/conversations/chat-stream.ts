/**
 * SSE wire types + parser for the per-item chat stream.
 *
 * The stream encoding follows server-sent-events (one `event:` line + one
 * `data:` JSON blob per record, blank-line delimited). Both halves of the
 * pipeline — server (`/api/projects/[projectId]/conversations/[id]/stream`)
 * and the `useChatStream` hook — share these types so a payload-shape
 * change shows up as a TS error on both sides.
 */

export type StreamEventName =
  | "text_delta"
  | "tool_call_started"
  | "tool_call_completed"
  | "round_boundary"
  | "proposal_staged"
  | "ask_user_question"
  | "guardrail_blocked"
  | "guardrail_flagged"
  | "guardrail_usage"
  | "usage"
  | "done"
  | "error";

export type GuardrailStage = "input" | "tool_result" | "output";

export type StreamPayload =
  | { kind: "text_delta"; delta: string }
  | { kind: "tool_call_started"; callId: string; name: string; arguments: Record<string, unknown> }
  | { kind: "tool_call_completed"; callId: string; ok: boolean }
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
      stage: GuardrailStage;
      reason: string;
      categories?: readonly string[];
    }
  | {
      kind: "guardrail_flagged";
      stage: GuardrailStage;
      reason: string;
      categories?: readonly string[];
    }
  | { kind: "guardrail_usage"; tokensIn: number; tokensOut: number; costCents?: number }
  | { kind: "usage"; tokensIn: number; tokensOut: number; costCents?: number }
  | { kind: "done" }
  | { kind: "error"; message: string };

export type StreamingToolCall = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean | null;
};

/**
 * One settled inner round of a multi-round turn — the assistant text + the
 * tool calls dispatched in that round. The server has already persisted
 * the matching rows but the client hasn't refetched yet, so we keep the
 * snapshot visible until the post-stream `invalidate` swaps in the
 * official transcript. Without this, the next round's text deltas would
 * be appended to the previous round's bubble.
 */
export type SettledRound = {
  text: string;
  toolCalls: readonly StreamingToolCall[];
};

export type GuardrailNotice = {
  stage: GuardrailStage;
  reason: string;
  blocked: boolean;
  categories?: readonly string[];
};

export type StreamingState = {
  /**
   * The user's just-sent message, held locally until the post-stream
   * `invalidate` brings the persisted row in. Without this the user's
   * message vanishes from the textarea and only reappears when the
   * stream finishes — looks like the message popped in above the
   * assistant bubble.
   */
  pendingUserMessage: string | null;
  settledRounds: readonly SettledRound[];
  text: string;
  toolCalls: StreamingToolCall[];
  question: { question: string; options: readonly string[] | null; multiSelect: boolean } | null;
  /**
   * Guardrail notices accumulated during this stream. The chat pane
   * renders them inline so the user sees *why* the assistant stopped or
   * was flagged. Cleared on the next send.
   */
  guardrailNotices: readonly GuardrailNotice[];
  error: string | null;
  done: boolean;
};

export const EMPTY_STREAM: StreamingState = {
  pendingUserMessage: null,
  settledRounds: [],
  text: "",
  toolCalls: [],
  question: null,
  guardrailNotices: [],
  error: null,
  done: true,
};

export function parseSseEvent(
  rawEvent: string,
): { name: StreamEventName; payload: StreamPayload } | null {
  let name: StreamEventName | null = null;
  const dataLines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("event: ")) name = line.slice(7).trim() as StreamEventName;
    else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
  }
  if (!name || dataLines.length === 0) return null;
  try {
    const payload = JSON.parse(dataLines.join("\n")) as StreamPayload;
    return { name, payload };
  } catch {
    return null;
  }
}
