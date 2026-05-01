/**
 * Anthropic LLM adapter.
 *
 * THE ONLY FILE in the tree allowed to import `@anthropic-ai/sdk`. The arch
 * test `src/__arch__/no-llm-vendor-leak.test.ts` enforces it — same as the
 * OpenAI adapter, just a sibling.
 *
 * Uses the Messages API in streaming mode. The agent loop's vendor-neutral
 * `LlmMessage` shape is translated at the boundary:
 *   - `system` messages collapse into the top-level `system` field (Anthropic
 *     has no `system` role inside `messages`; consecutive system turns are
 *     joined with blank lines, matching how the prompt builder produces them).
 *   - `user` / `assistant` text turns map 1:1 onto `MessageParam`.
 *   - `assistant` turns that requested tools fan out into a content-array
 *     with `text` blocks followed by `tool_use` blocks (Anthropic requires
 *     `tool_use` blocks to be in the same assistant turn that produced them).
 *   - `tool` results fold into the *next* user turn as `tool_result` content
 *     blocks. Adjacent tool results in the loop's transcript are merged into
 *     one user message so the alternating-roles invariant holds.
 *
 * Cost: USD cents are reported when the LlmProvider row carries
 * `inputPriceCentsPerMtok` / `outputPriceCentsPerMtok`. Without prices the
 * cost is left undefined and budget tracking silently undercounts that turn.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  JudgeClassifyArgs,
  JudgeClassifyResult,
  JudgeClient,
} from "@/agent/guardrail/judge-client";
import type {
  LlmAdapter,
  LlmEvent,
  LlmMessage,
  LlmRequest,
  LlmToolCall,
  LlmToolResult,
} from "@/agent/llm/types";
import { logger } from "@/server/logger";

const DEFAULT_MODEL = "claude-sonnet-4-6";
/**
 * Anthropic requires `max_tokens` on every request. Models cap their own
 * output regardless, so this is a generous ceiling that the loop's per-turn
 * `maxOutputTokens` overrides when set.
 */
const DEFAULT_MAX_TOKENS = 8192;

export type AnthropicAdapterConfig = {
  apiKey: string;
  /** Display label, surfaced in the LLM switcher. */
  label: string;
  /** Defaults to "claude-sonnet-4-6". */
  model?: string;
  /**
   * Optional base URL. Anthropic accepts the same URL shape as the public
   * endpoint for Bedrock/Vertex proxies that mirror the Messages API.
   */
  baseUrl?: string;
  /**
   * Sampling temperature applied when the per-request `temperature` is
   * undefined. Anthropic models past Opus 4.6 ignore the field, but the
   * SDK still accepts it — no need to gate.
   */
  defaultTemperature?: number;
  /** USD cents per million prompt tokens. Null/undefined = no cost reported. */
  inputPriceCentsPerMtok?: number | null;
  /** USD cents per million output tokens. Null/undefined = no cost reported. */
  outputPriceCentsPerMtok?: number | null;
};

export class AnthropicAdapter implements LlmAdapter {
  readonly kind = "anthropic" as const;
  readonly label: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly defaultTemperature: number | undefined;
  private readonly inputPriceCentsPerMtok: number | undefined;
  private readonly outputPriceCentsPerMtok: number | undefined;

  constructor(config: AnthropicAdapterConfig) {
    this.label = config.label;
    this.model = config.model && config.model.length > 0 ? config.model : DEFAULT_MODEL;
    this.defaultTemperature =
      typeof config.defaultTemperature === "number" ? config.defaultTemperature : undefined;
    this.inputPriceCentsPerMtok =
      typeof config.inputPriceCentsPerMtok === "number" ? config.inputPriceCentsPerMtok : undefined;
    this.outputPriceCentsPerMtok =
      typeof config.outputPriceCentsPerMtok === "number"
        ? config.outputPriceCentsPerMtok
        : undefined;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async *streamMessages(req: LlmRequest): AsyncIterable<LlmEvent> {
    const { system, messages } = toAnthropicMessages(req.messages);
    const tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));

    const effectiveTemperature =
      req.temperature !== undefined ? req.temperature : this.defaultTemperature;
    const model = req.model || this.model;
    const maxTokens = req.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
    const requestStartedAt = Date.now();
    logger.debug(
      {
        adapter: this.kind,
        model,
        messages: messages.length,
        tools: tools.length,
        temperature: effectiveTemperature,
        maxOutputTokens: maxTokens,
      },
      "llm: request start",
    );

    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      stream = await this.client.messages.create(
        {
          model,
          max_tokens: maxTokens,
          messages,
          ...(system ? { system } : {}),
          ...(tools.length > 0 ? { tools } : {}),
          ...(effectiveTemperature !== undefined ? { temperature: effectiveTemperature } : {}),
          stream: true,
        },
        req.signal ? { signal: req.signal } : undefined,
      );
    } catch (err) {
      logger.error(
        {
          adapter: this.kind,
          model,
          durationMs: Date.now() - requestStartedAt,
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        "llm: request failed before stream",
      );
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    // Tool calls stream as a `content_block_start` (with id + name) followed by
    // a sequence of `input_json_delta` partials and a `content_block_stop`.
    // We accumulate per-index until stop, then emit a single `tool_call` event.
    const pending = new Map<number, { id: string; name: string; argsBuf: string }>();

    // Anthropic only surfaces input tokens on `message_start` and output
    // tokens on `message_delta`; collect both and emit one `usage` event.
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;

    try {
      for await (const event of stream) {
        if (event.type === "message_start") {
          const usage = event.message.usage;
          if (usage) {
            inputTokens = usage.input_tokens ?? 0;
            outputTokens = usage.output_tokens ?? 0;
            sawUsage = true;
          }
          continue;
        }

        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "tool_use") {
            pending.set(event.index, { id: block.id, name: block.name, argsBuf: "" });
          }
          continue;
        }

        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            if (delta.text) yield { kind: "text_delta", delta: delta.text };
          } else if (delta.type === "input_json_delta") {
            const slot = pending.get(event.index);
            if (slot) slot.argsBuf += delta.partial_json;
          }
          continue;
        }

        if (event.type === "content_block_stop") {
          const slot = pending.get(event.index);
          if (!slot) continue;
          let parsed: Record<string, unknown> = {};
          try {
            parsed = slot.argsBuf ? (JSON.parse(slot.argsBuf) as Record<string, unknown>) : {};
          } catch {
            parsed = { __unparsable_arguments__: slot.argsBuf };
          }
          const call: LlmToolCall = { id: slot.id, name: slot.name, arguments: parsed };
          pending.delete(event.index);
          yield { kind: "tool_call", call };
          continue;
        }

        if (event.type === "message_delta") {
          const usage = event.usage;
          if (usage) {
            // `message_delta.usage` is cumulative per the SDK comments. Take
            // the latest values rather than summing.
            if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
            if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
            sawUsage = true;
          }
          continue;
        }

        if (event.type === "message_stop") {
          if (sawUsage) {
            const costCents = this.estimateCostCents(inputTokens, outputTokens);
            yield {
              kind: "usage",
              tokensIn: inputTokens,
              tokensOut: outputTokens,
              ...(costCents !== undefined ? { costCents } : {}),
            };
          }
          yield { kind: "done" };
          return;
        }
      }
      yield { kind: "done" };
    } catch (err) {
      logger.error(
        {
          adapter: this.kind,
          model,
          durationMs: Date.now() - requestStartedAt,
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        "llm: stream threw",
      );
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  private estimateCostCents(tokensIn: number, tokensOut: number): number | undefined {
    const priceIn = this.inputPriceCentsPerMtok;
    const priceOut = this.outputPriceCentsPerMtok;
    if (priceIn === undefined || priceOut === undefined) return undefined;
    return Math.round((tokensIn * priceIn + tokensOut * priceOut) / 1_000_000);
  }

  formatToolResult(call: LlmToolCall, result: unknown): LlmToolResult {
    return {
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content: typeof result === "string" ? result : JSON.stringify(result),
    };
  }
}

/**
 * Single-shot single-token classifier client used by `LlmJudgeGuardrail`.
 *
 * Anthropic's Messages API requires `max_tokens` on every request. The
 * judge's verdict is one token, but we leave a small buffer in case the
 * model emits a stop token after a brief preamble — the guardrail does its
 * own label match on `text.startsWith(label)`.
 */
export type AnthropicJudgeClientConfig = {
  apiKey: string;
  model: string;
  baseUrl?: string;
};

const JUDGE_MAX_TOKENS = 32;

export class AnthropicJudgeClient implements JudgeClient {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(config: AnthropicJudgeClientConfig) {
    this.model = config.model;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async classify(args: JudgeClassifyArgs): Promise<JudgeClassifyResult> {
    const resp = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: JUDGE_MAX_TOKENS,
        system: args.system,
        messages: [{ role: "user", content: args.user }],
      },
      args.signal ? { signal: args.signal } : undefined,
    );
    const text = resp.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    const usageRaw = resp.usage;
    if (usageRaw) {
      const tokensIn = usageRaw.input_tokens ?? 0;
      const tokensOut = usageRaw.output_tokens ?? 0;
      if (tokensIn > 0 || tokensOut > 0) {
        return { text, usage: { tokensIn, tokensOut } };
      }
    }
    return { text };
  }
}

/**
 * Translate the loop's vendor-neutral transcript into Anthropic's
 * `(system, messages[])` shape. System turns collapse into a single string;
 * `tool` results fold into the *next* user turn as `tool_result` blocks so
 * the user/assistant alternation Anthropic requires holds.
 */
function toAnthropicMessages(messages: readonly LlmMessage[]): {
  system: string;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];

  // Buffer for tool results that need to attach to the next user turn.
  let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    out.push({
      role: "user",
      content: pendingToolResults,
    });
    pendingToolResults = [];
  };

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }

    if (m.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
      });
      continue;
    }

    flushToolResults();

    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }

    // assistant
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (m.content) {
      blocks.push({ type: "text", text: m.content });
    }
    for (const call of m.toolCalls ?? []) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.arguments ?? {},
      });
    }
    if (blocks.length === 0) {
      // Anthropic rejects empty assistant turns. Skip them — the loop only
      // produces this shape when an upstream message was cancelled mid-tool.
      continue;
    }
    out.push({ role: "assistant", content: blocks });
  }

  flushToolResults();

  return { system: systemParts.join("\n\n"), messages: out };
}
