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
  | "proposal_staged"
  | "ask_user_question"
  | "usage"
  | "done"
  | "error";

export type StreamPayload =
  | { kind: "text_delta"; delta: string }
  | { kind: "tool_call_started"; callId: string; name: string; arguments: Record<string, unknown> }
  | { kind: "tool_call_completed"; callId: string; ok: boolean }
  | { kind: "proposal_staged"; proposalId: string; proposalKind: string; toolName: string }
  | {
      kind: "ask_user_question";
      question: string;
      options: readonly string[] | null;
      multiSelect: boolean;
    }
  | { kind: "usage"; tokensIn: number; tokensOut: number; costCents?: number }
  | { kind: "done" }
  | { kind: "error"; message: string };

export type StreamingState = {
  text: string;
  toolCalls: { callId: string; name: string; ok: boolean | null }[];
  question: { question: string; options: readonly string[] | null; multiSelect: boolean } | null;
  error: string | null;
  done: boolean;
};

export const EMPTY_STREAM: StreamingState = {
  text: "",
  toolCalls: [],
  question: null,
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
