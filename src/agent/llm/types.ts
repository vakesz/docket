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
 *
 * `LLM_KINDS` lists the kinds whose adapter is *actually wired*.
 * `src/__arch__/llm-kinds-have-adapters.test.ts` keeps the runtime switch
 * in `registry.ts` and the UI selector in lockstep — adding a kind here
 * without a matching `case` is a CI failure.
 */

export const LLM_KINDS = ["openai", "anthropic"] as const;
export type LlmKind = (typeof LLM_KINDS)[number];

export function isLlmKind(value: string): value is LlmKind {
  return (LLM_KINDS as readonly string[]).includes(value);
}

/** Human-readable name shown in the LLM provider form picker. */
export const LLM_KIND_LABELS: Record<LlmKind, string> = {
  openai: "OpenAI / OpenAI-compatible",
  anthropic: "Anthropic Claude",
};

/**
 * UI metadata for the LLM provider step / form. Per-vendor copy
 * (placeholder API key prefix, suggested models, default labels per role)
 * lives here so generic step renderers stay registry-driven — adding a
 * new vendor is one new `LLM_KINDS` entry plus one new entry here. No
 * `if (kind === "openai")` chains in components.
 */
export type LlmKindMeta = {
  /** Suggested values for the model `<datalist>` — non-binding. */
  modelSuggestions: readonly string[];
  /** Per-role default `label` text. */
  defaultLabelByRole: { chat: string; guardrail: string };
  /** Per-role default `model` text — used when the operator leaves it blank. */
  defaultModelByRole: { chat: string; guardrail: string };
  /** Placeholder shown in the API-key field. */
  apiKeyPlaceholder: string;
  /** Help text under the API-key field (encryption note appended elsewhere). */
  apiKeyHelp: string;
  /** Placeholder for the optional base URL field. */
  baseUrlPlaceholder: string;
  /** Help text under the optional base URL field. */
  baseUrlHelp: string;
  /** Help text under the model field for the chat role (guardrail row uses fixed copy). */
  modelHelp: string;
  /**
   * Optional per-vendor warning rendered above the form — e.g. an Azure-
   * style "you need to deploy this model in your foundry first" hint.
   */
  foundryHint?: { title: string; body: string };
};

export const LLM_KIND_META: Record<LlmKind, LlmKindMeta> = {
  openai: {
    modelSuggestions: [
      "gpt-5",
      "gpt-5-mini",
      "gpt-5-nano",
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-4.1-mini",
    ],
    defaultLabelByRole: { chat: "OpenAI", guardrail: "OpenAI guardrail" },
    defaultModelByRole: { chat: "gpt-5", guardrail: "gpt-5-nano" },
    apiKeyPlaceholder: "sk-proj-aBc1234567890dEfGhIjKlMnOpQrStUvWxYz",
    apiKeyHelp: "OpenAI keys start with sk- / sk-proj-.",
    baseUrlPlaceholder: "https://api.openai.com/v1",
    baseUrlHelp:
      "Blank uses OpenAI's public endpoint. Set for Azure OpenAI / Foundry / Ollama / a proxy.",
    modelHelp:
      "Pick a suggestion or type any deployment name (Azure Foundry users — paste your deployment id).",
    foundryHint: {
      title: "Adding an Azure AI Foundry model",
      body: "Use the project's OpenAI v1 endpoint as the Base URL — the path must end with /openai/v1/. Set Model to the deployment name shown in Foundry → Model deployments (for example gpt-5).",
    },
  },
  anthropic: {
    modelSuggestions: [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-3-7-sonnet-latest",
      "claude-3-5-haiku-latest",
    ],
    defaultLabelByRole: { chat: "Anthropic Claude", guardrail: "Claude guardrail" },
    defaultModelByRole: { chat: "claude-sonnet-4-6", guardrail: "claude-haiku-4-5-20251001" },
    apiKeyPlaceholder: "sk-ant-api03-0000000000000000000000000000000000",
    apiKeyHelp: "Anthropic keys start with sk-ant-.",
    baseUrlPlaceholder: "https://api.anthropic.com",
    baseUrlHelp:
      "Blank uses Anthropic's public endpoint. Set for AWS Bedrock / GCP Vertex / a proxy that mirrors the Messages API.",
    modelHelp:
      "Pick a suggestion or type any model id (e.g. claude-opus-4-7). Bedrock / Vertex users — paste the deployment id used by the proxy.",
  },
};

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
  /**
   * Aborts the in-flight request when the caller (e.g. the SSE handler's
   * `req.signal`) goes away. Adapters forward this to the vendor SDK so a
   * cancelled browser request stops billing the LLM.
   */
  signal?: AbortSignal;
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
