/**
 * LLM adapter interface — vendor-neutral.
 *
 * The agent loop never imports a vendor SDK directly; it only sees
 * `LlmAdapter` values handed in by `selectAdapterFor(project)`. Adding a
 * new vendor (Anthropic, Gemini, Bedrock, Ollama, …) is a new file under
 * `src/agent/llm/` plus a registry entry — no other agent code changes.
 *
 * Architecture test `src/__arch__/no-llm-vendor-leak.test.ts` enforces
 * that the only file importing `openai` is `src/agent/llm/openai.ts`. The
 * same rule will quarantine future SDKs as they land.
 */

export const LLM_KINDS = ["openai", "anthropic", "gemini", "ollama"] as const;
export type LlmKind = (typeof LLM_KINDS)[number];

/**
 * One round-trip request to a chat-style LLM. The adapter consumes this and
 * yields a stream of vendor-neutral events. Tool definitions are
 * pre-translated into the adapter's expected JSON Schema shape — neutral
 * because all major vendors converged on JSON Schema for tools.
 */
export type LlmRequest = {
  model: string;
  /** System + transcript, in order. */
  messages: readonly LlmMessage[];
  tools: readonly LlmToolDef[];
  /** Sampling temperature; adapters clamp to their supported range. */
  temperature?: number;
  /** Hard cap on output tokens, including tool-call arguments. */
  maxOutputTokens?: number;
};

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      /** Tool calls the assistant requested in this turn (may be empty). */
      toolCalls?: readonly LlmToolCall[];
    }
  | {
      role: "tool";
      /** The id from the corresponding `LlmToolCall.id`. */
      toolCallId: string;
      toolName: string;
      content: string;
    };

export type LlmToolCall = {
  id: string;
  name: string;
  /** Arguments object — adapter is responsible for JSON-stringification. */
  arguments: Record<string, unknown>;
};

export type LlmToolDef = {
  name: string;
  description: string;
  /** JSON Schema describing the arguments object. */
  parameters: Record<string, unknown>;
};

/**
 * Streaming event produced by the adapter. The agent loop interprets these
 * — surface them on the SSE stream the chat UI consumes.
 *
 *   - `text_delta` — assistant text token(s)
 *   - `tool_call` — assistant requested a tool; the loop dispatches and
 *     re-feeds the tool result on the next turn
 *   - `usage` — token / cost accounting; emitted at most once per turn
 *   - `done` — adapter finished this turn (assistant message complete)
 *   - `error` — adapter-fatal; loop aborts the turn and surfaces the message
 */
export type LlmEvent =
  | { kind: "text_delta"; delta: string }
  | { kind: "tool_call"; call: LlmToolCall }
  | {
      kind: "usage";
      tokensIn: number;
      tokensOut: number;
      /** Optional cost in USD cents the adapter computed (accuracy varies). */
      costCents?: number;
    }
  | { kind: "done" }
  | { kind: "error"; message: string };

/**
 * Tool result shape the adapter wants when re-feeding the next turn.
 * Adapters that need extra metadata (e.g. OpenAI's `tool_call_id`) build
 * it inside `formatToolResult`.
 */
export type LlmToolResult = LlmMessage & { role: "tool" };

export interface LlmAdapter {
  readonly kind: LlmKind;
  /** Display label, e.g. "OpenAI · GPT-5". Only used for log lines / UI. */
  readonly label: string;

  /**
   * Stream a chat completion. Implementations MUST yield exactly one
   * `{ kind: "done" }` or `{ kind: "error" }` as the final event.
   */
  streamMessages(req: LlmRequest): AsyncIterable<LlmEvent>;

  /**
   * Build the next-turn `tool` message from a tool's structured result.
   * Stays on the adapter so vendor-specific quirks (id naming, ordering)
   * don't bleed into the loop.
   */
  formatToolResult(call: LlmToolCall, result: unknown): LlmToolResult;
}
