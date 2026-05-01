/**
 * OpenAI LLM adapter.
 *
 * THE ONLY FILE in the tree allowed to import `openai`. The arch test
 * `src/__arch__/no-llm-vendor-leak.test.ts` enforces it. Adding a new
 * vendor is a sibling file under `src/agent/llm/` plus a registry entry.
 *
 * Uses the Responses API in streaming mode. Chat-style messages are
 * translated into Responses input items at the boundary so the agent loop
 * stays vendor-neutral.
 *
 * Model defaults to `gpt-5` (our daily driver) but the LlmProvider row's
 * `model` overrides it. Cost is reported in USD cents when usage data is
 * available and the LlmProvider row carries `inputPriceCentsPerMtok` /
 * `outputPriceCentsPerMtok`. Without prices the cost is left undefined and
 * budget tracking silently undercounts that turn — fill the price fields
 * when adding a model.
 */

import OpenAI from "openai";
import type {
  JudgeClassifyArgs,
  JudgeClassifyResult,
  JudgeClient,
} from "@/agent/guardrail/judge-client";
import type {
  LlmAdapter,
  LlmEvent,
  LlmRequest,
  LlmToolCall,
  LlmToolResult,
} from "@/agent/llm/types";
import { logger } from "@/server/logger";

const DEFAULT_MODEL = "gpt-5";

export type OpenAiAdapterConfig = {
  apiKey: string;
  /** Display label, surfaced in the LLM switcher. */
  label: string;
  /** Defaults to "gpt-5". */
  model?: string;
  /**
   * Optional base URL. For Azure AI Foundry use the project's OpenAI v1
   * endpoint ending in `/openai/v1/`; for Ollama or proxies, point at their
   * OpenAI-compatible root.
   */
  baseUrl?: string;
  /**
   * Sampling temperature applied when the per-request `temperature` is
   * undefined. Set by the registry from `Project.defaultTemperature`.
   */
  defaultTemperature?: number;
  /** USD cents per million prompt tokens. Null/undefined = no cost reported. */
  inputPriceCentsPerMtok?: number | null;
  /** USD cents per million output tokens. Null/undefined = no cost reported. */
  outputPriceCentsPerMtok?: number | null;
};

export class OpenAiAdapter implements LlmAdapter {
  readonly kind = "openai" as const;
  readonly label: string;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly defaultTemperature: number | undefined;
  private readonly inputPriceCentsPerMtok: number | undefined;
  private readonly outputPriceCentsPerMtok: number | undefined;

  constructor(config: OpenAiAdapterConfig) {
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
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async *streamMessages(req: LlmRequest): AsyncIterable<LlmEvent> {
    const tools = req.tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
      strict: false,
    }));

    const input = toResponsesInput(req.messages);

    const effectiveTemperature =
      req.temperature !== undefined ? req.temperature : this.defaultTemperature;

    const model = req.model || this.model;
    const requestStartedAt = Date.now();
    logger.debug(
      {
        adapter: this.kind,
        model,
        messages: req.messages.length,
        tools: tools.length,
        temperature: effectiveTemperature,
        maxOutputTokens: req.maxOutputTokens,
      },
      "llm: request start",
    );

    let stream: AsyncIterable<unknown>;
    try {
      stream = (await this.client.responses.create(
        {
          model,
          input,
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
          ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
          ...(effectiveTemperature !== undefined ? { temperature: effectiveTemperature } : {}),
        } as unknown as Parameters<OpenAI["responses"]["create"]>[0],
        req.signal ? { signal: req.signal } : undefined,
      )) as AsyncIterable<unknown>;
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

    // Track in-flight tool calls so we can emit a single `tool_call` event
    // once each one is fully assembled. The Responses API streams arguments
    // token-by-token under `response.function_call_arguments.delta` /
    // `.done`, then tags them with the function name on `response.output_item.added`.
    const pending = new Map<string, { name: string; argsBuf: string }>();

    try {
      for await (const event of stream) {
        const evt = event as { type?: string; [k: string]: unknown };
        const type = evt.type ?? "";

        if (type === "response.output_text.delta") {
          const delta = (evt["delta"] as string | undefined) ?? "";
          if (delta) yield { kind: "text_delta", delta };
          continue;
        }

        if (type === "response.output_item.added") {
          const item = evt["item"] as
            | { type?: string; id?: string; call_id?: string; name?: string }
            | undefined;
          if (item?.type === "function_call" && item.call_id && item.name) {
            pending.set(item.id ?? item.call_id, { name: item.name, argsBuf: "" });
          }
          continue;
        }

        if (type === "response.function_call_arguments.delta") {
          const itemId = (evt["item_id"] as string | undefined) ?? "";
          const delta = (evt["delta"] as string | undefined) ?? "";
          const slot = pending.get(itemId);
          if (slot) slot.argsBuf += delta;
          continue;
        }

        if (type === "response.function_call_arguments.done") {
          const itemId = (evt["item_id"] as string | undefined) ?? "";
          const slot = pending.get(itemId);
          if (!slot) continue;
          const callId = (evt["call_id"] as string | undefined) ?? itemId;
          let parsed: Record<string, unknown> = {};
          try {
            parsed = slot.argsBuf ? (JSON.parse(slot.argsBuf) as Record<string, unknown>) : {};
          } catch {
            parsed = { __unparsable_arguments__: slot.argsBuf };
          }
          const call: LlmToolCall = { id: callId, name: slot.name, arguments: parsed };
          pending.delete(itemId);
          yield { kind: "tool_call", call };
          continue;
        }

        if (type === "response.completed") {
          const usage = (
            evt["response"] as
              | { usage?: { input_tokens?: number; output_tokens?: number } }
              | undefined
          )?.usage;
          if (usage) {
            const tokensIn = usage.input_tokens ?? 0;
            const tokensOut = usage.output_tokens ?? 0;
            const costCents = this.estimateCostCents(tokensIn, tokensOut);
            yield {
              kind: "usage",
              tokensIn,
              tokensOut,
              ...(costCents !== undefined ? { costCents } : {}),
            };
          }
          yield { kind: "done" };
          return;
        }

        if (type === "response.error" || type === "error") {
          const message =
            (evt["error"] as { message?: string } | undefined)?.message ?? "OpenAI stream error";
          logger.error(
            {
              adapter: this.kind,
              model,
              durationMs: Date.now() - requestStartedAt,
              err: message,
            },
            "llm: stream error event",
          );
          yield { kind: "error", message };
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
 * Reasoning models (`gpt-5*`, `o1*`, `o3*`, `o4*`) burn invisible reasoning
 * tokens before producing a verdict. A tight cap means they spend the whole
 * budget thinking and return an empty string, which the guardrail would
 * silently allow. Two-pronged fix: pin `reasoning_effort: "minimal"` so the
 * budget actually reaches the verdict, and bump the cap so even a
 * misconfigured deployment that doesn't honor the effort hint still has
 * room for one token. Non-reasoning models keep `temperature: 0` for
 * deterministic verdicts.
 */
export type OpenAiJudgeClientConfig = {
  apiKey: string;
  model: string;
  baseUrl?: string;
};

const REASONING_OUTPUT_CAP = 256;
const NON_REASONING_OUTPUT_CAP = 16;

export class OpenAiJudgeClient implements JudgeClient {
  readonly model: string;
  private readonly client: OpenAI;

  constructor(config: OpenAiJudgeClientConfig) {
    this.model = config.model;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async classify(args: JudgeClassifyArgs): Promise<JudgeClassifyResult> {
    const reasoning = isReasoningModel(this.model);
    // The OpenAI SDK types `reasoning_effort` only on the responses-API
    // params shape; chat.completions accepts the same key for gpt-5* /
    // o-series models even though the published type doesn't surface it.
    type ChatParams = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
      reasoning_effort?: "minimal" | "low" | "medium" | "high";
    };
    const params: ChatParams = {
      model: this.model,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
      max_completion_tokens: reasoning ? REASONING_OUTPUT_CAP : NON_REASONING_OUTPUT_CAP,
      stream: false,
    };
    if (reasoning) {
      params.reasoning_effort = "minimal";
    } else {
      params.temperature = 0;
    }
    const resp = await this.client.chat.completions.create(
      params,
      args.signal ? { signal: args.signal } : undefined,
    );
    const text = resp.choices?.[0]?.message?.content ?? "";
    const usageRaw = resp.usage;
    if (usageRaw) {
      const tokensIn = usageRaw.prompt_tokens ?? 0;
      const tokensOut = usageRaw.completion_tokens ?? 0;
      if (tokensIn > 0 || tokensOut > 0) {
        return { text, usage: { tokensIn, tokensOut } };
      }
    }
    return { text };
  }
}

/**
 * Reasoning-model detector for chat-completions param shape. Matches
 * `gpt-5*` and the `o*` reasoning families. The list is conservative —
 * adding a model that requires `max_completion_tokens` only here costs
 * nothing; missing one re-introduces the silent-allow bug.
 */
function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return /^(gpt-5|o1|o3|o4)\b/.test(m);
}

function toResponsesInput(messages: readonly import("@/agent/llm/types").LlmMessage[]) {
  // The Responses API accepts a flat input array of typed items: messages,
  // function_call, function_call_output. Tool calls are attached to the
  // assistant turn that produced them.
  //
  // We emit the explicit `type: "message"` + content-parts form rather than
  // the bare `{ role, content }` shorthand — api.openai.com infers the type,
  // but Azure AI Foundry's stricter validator rejects items without one.
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: m.content }],
      });
    } else if (m.role === "user") {
      out.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: m.content }],
      });
    } else if (m.role === "assistant") {
      if (m.content) {
        out.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: m.content }],
        });
      }
      for (const call of m.toolCalls ?? []) {
        out.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        });
      }
    } else if (m.role === "tool") {
      out.push({
        type: "function_call_output",
        call_id: m.toolCallId,
        output: m.content,
      });
    }
  }
  return out;
}
