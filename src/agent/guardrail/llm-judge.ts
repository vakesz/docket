/**
 * LLM-judge guardrail.
 *
 * One-shot, single-token classification using a cheap model
 * (operator picks one — typically a `*-nano` / `*-mini` / `*-haiku` tier).
 * Three responsibilities, one model:
 *
 *   1. **Input scope check** — classifies whether a user message is
 *      about software / work-item topics. Off-topic messages
 *      ("how to make pancakes") return `block` so the chatbot stays in
 *      its lane.
 *   2. **Tool-result injection check** — scans tool output before it
 *      re-enters the prompt. Catches prompt injection from item bodies,
 *      comments, web_fetch markdown, MCP responses.
 *   3. **Output safety check** — classifies the assistant's final reply
 *      for harmful content (hate / harassment / violence / sexual).
 *      Always `flag` (banner), never `block` — the user already saw the
 *      streamed text. Opt-in via `outputCheckEnabled`.
 *
 * Cost: ~300–500 input tokens, a handful of output tokens per call. The
 * judge runs against an `LlmProvider` row with `role='guardrail'`. Per
 * project, that row's API key + base URL + model name flow into a
 * vendor-specific `JudgeClient` instance built by the guardrail registry —
 * `LlmJudgeGuardrail` itself is vendor-neutral.
 *
 * Vendor SDK quarantine: this file imports no vendor SDK. The OpenAI and
 * Anthropic judge clients live alongside their chat adapters under
 * `src/agent/llm/<kind>.ts` and the arch test
 * `src/__arch__/no-llm-vendor-leak.test.ts` keeps the SDKs there.
 *
 * Prompt overrides: the three system prompts (injection / scope / output
 * safety) default to the bundled strings in `judge-prompts.ts`, but
 * `loadJudgePrompts` resolves operator overrides from
 * `prompt.guardrail.*` global settings before the registry hands them
 * here. Empty overrides fall back to the defaults so an admin clearing
 * the field doesn't leave the judge with no instructions.
 */

import type { JudgeClient } from "@/agent/guardrail/judge-client";
import { DEFAULT_JUDGE_PROMPTS, type ResolvedJudgePrompts } from "@/agent/guardrail/judge-prompts";
import type {
  CheckToolResultArgs,
  Guardrail,
  GuardrailDecision,
  GuardrailStage,
  GuardrailUsage,
} from "@/agent/guardrail/types";
import { stringifyToolResult } from "@/agent/guardrail/types";
import { errFields } from "@/server/log-fields";
import { logger } from "@/server/logger";

/** Tool-result snippets longer than this get truncated before the judge sees them. */
const MAX_TOOL_RESULT_CHARS = 4000;
/** Hard ceiling on input length we'll send to the scope classifier. */
const MAX_INPUT_CHARS = 2000;

export type LlmJudgeConfig = {
  /** Vendor-specific classifier client built by `selectGuardrailFor`. */
  client: JudgeClient;
  /** Display label for log lines. */
  label?: string;
  /**
   * System prompts for the three classifiers. Loaded from global settings
   * (`prompt.guardrail.injection` / `prompt.guardrail.scope` /
   * `prompt.guardrail.output-safety`); defaults to the bundled prompts in
   * `judge-prompts.ts` when callers omit it.
   */
  prompts?: ResolvedJudgePrompts;
  /** Enables the off-topic scope check on user input. Default true. */
  scopeCheckEnabled?: boolean;
  /** Enables the output safety check on the final assistant text. Default false (one extra round-trip per turn). */
  outputCheckEnabled?: boolean;
  /** When true, scope-check `off-topic` returns block instead of flag. Default true. */
  blockOffTopic?: boolean;
  /** When true, injection hits return block instead of flag. Default true. */
  blockOnInjection?: boolean;
  /**
   * Per-million-tokens prices in USD cents, mirroring `LlmProvider`. When
   * provided, each decision carries a `costCents` figure derived from the
   * usage block on the underlying response. Null/undefined = analytics
   * undercounts guardrail spend (token columns still increment).
   */
  inputPriceCentsPerMtok?: number | null;
  outputPriceCentsPerMtok?: number | null;
};

export class LlmJudgeGuardrail implements Guardrail {
  readonly kind = "llm-judge" as const;
  readonly label: string;
  private readonly client: JudgeClient;
  private readonly prompts: ResolvedJudgePrompts;
  private readonly scopeCheckEnabled: boolean;
  private readonly outputCheckEnabled: boolean;
  private readonly blockOffTopic: boolean;
  private readonly blockOnInjection: boolean;

  private readonly inputPriceCentsPerMtok: number | null;
  private readonly outputPriceCentsPerMtok: number | null;

  constructor(config: LlmJudgeConfig) {
    if (!config.client.model || config.client.model.length === 0) {
      throw new Error("LlmJudgeGuardrail requires a JudgeClient with a non-empty model");
    }
    this.client = config.client;
    this.label = config.label ?? "LLM judge";
    this.prompts = config.prompts ?? DEFAULT_JUDGE_PROMPTS;
    this.scopeCheckEnabled = config.scopeCheckEnabled ?? true;
    this.outputCheckEnabled = config.outputCheckEnabled ?? false;
    this.blockOffTopic = config.blockOffTopic ?? true;
    this.blockOnInjection = config.blockOnInjection ?? true;
    this.inputPriceCentsPerMtok = config.inputPriceCentsPerMtok ?? null;
    this.outputPriceCentsPerMtok = config.outputPriceCentsPerMtok ?? null;
  }

  async checkInput(text: string, signal?: AbortSignal): Promise<GuardrailDecision> {
    if (!this.scopeCheckEnabled) return { action: "allow" };
    const trimmed = text.trim();
    if (trimmed.length === 0) return { action: "allow" };
    const { verdict, usage } = await this.classify(
      "input",
      this.prompts.scopeSystem,
      trimmed.slice(0, MAX_INPUT_CHARS),
      ["on-topic", "off-topic"],
      signal,
    );
    if (verdict !== "off-topic") return withUsage({ action: "allow" }, usage);
    const reason = "llm-judge: off-topic for ticketing-system assistant";
    const decision: GuardrailDecision = this.blockOffTopic
      ? { action: "block", reason, categories: ["off-topic"] }
      : { action: "flag", reason, categories: ["off-topic"] };
    return withUsage(decision, usage);
  }

  async checkToolResult(
    args: CheckToolResultArgs,
    signal?: AbortSignal,
  ): Promise<GuardrailDecision> {
    // Prefer the loop's pre-extracted untrusted text when present (tools
    // tagged `mode: "fields"`). Fall back to stringifying the whole
    // envelope for tools at default (`mode: "full"`).
    const text = args.untrusted !== undefined ? args.untrusted : stringifyToolResult(args.result);
    if (!text) return { action: "allow" };
    const snippet = text.slice(0, MAX_TOOL_RESULT_CHARS);
    // The classifier's user message is the snippet alone — no `tool=NAME`
    // prefix. Verb-laden tool names ("propose_*", "delete_*") biased small
    // models toward "injection" verdicts on otherwise-benign payloads.
    const labels = ["safe", "suspicious", "injection"] as const;
    const first = await this.classify(
      "tool_result",
      this.prompts.injectionSystem,
      snippet,
      labels,
      signal,
      args.toolName,
    );
    let usage = first.usage;
    if (first.verdict === "safe" || first.verdict === null) {
      return withUsage({ action: "allow" }, usage);
    }
    if (first.verdict === "suspicious") {
      return withUsage(
        {
          action: "flag",
          reason: `llm-judge: suspicious content in tool result (${args.toolName})`,
          categories: ["suspicious"],
        },
        usage,
      );
    }
    // first.verdict === "injection". When we're configured to block, run
    // a second pass — small models are non-deterministic on opaque
    // payloads, and one positive isn't enough to hard-stop the turn.
    // Disagreement downgrades to `flag` so the user still sees a banner
    // without losing their conversation.
    if (this.blockOnInjection) {
      const second = await this.classify(
        "tool_result",
        this.prompts.injectionSystem,
        snippet,
        labels,
        signal,
        args.toolName,
      );
      usage = mergeUsage(usage, second.usage);
      if (second.verdict !== "injection") {
        return withUsage(
          {
            action: "flag",
            reason: `llm-judge: prompt injection suspected in tool result (${args.toolName}, single-shot only)`,
            categories: ["injection"],
          },
          usage,
        );
      }
    }
    const reason = `llm-judge: prompt injection in tool result (${args.toolName})`;
    const decision: GuardrailDecision = this.blockOnInjection
      ? { action: "block", reason, categories: ["injection"] }
      : { action: "flag", reason, categories: ["injection"] };
    return withUsage(decision, usage);
  }

  async checkOutput(text: string, signal?: AbortSignal): Promise<GuardrailDecision> {
    if (!this.outputCheckEnabled) return { action: "allow" };
    const trimmed = text.trim();
    if (trimmed.length === 0) return { action: "allow" };
    const { verdict, usage } = await this.classify(
      "output",
      this.prompts.outputSafetySystem,
      trimmed.slice(0, MAX_TOOL_RESULT_CHARS),
      ["safe", "unsafe"],
      signal,
    );
    if (verdict !== "unsafe") return withUsage({ action: "allow" }, usage);
    // Output is never blocked — the user has already seen the streamed
    // text. Mark the row so the chat pane can render a banner.
    return withUsage(
      { action: "flag", reason: "llm-judge: output flagged unsafe", categories: ["unsafe"] },
      usage,
    );
  }

  /**
   * Single-token classifier. Returns the matched label (or null on failure)
   * alongside a usage block when the response surfaced one. Failures are
   * silent at the call-site (allow the action — a guardrail outage must
   * not break chat) but every failure emits a structured log line so an
   * operator can tell whether the layer is actually working. Equally,
   * unparseable verdicts log at `warn` so a model that returns "ok" or
   * "yes" surfaces in metrics rather than silently allowing.
   */
  private async classify(
    stage: GuardrailStage,
    system: string,
    user: string,
    labels: readonly string[],
    signal?: AbortSignal,
    toolName?: string,
  ): Promise<{ verdict: string | null; usage: GuardrailUsage | undefined }> {
    const startedAt = Date.now();
    const logCtx = {
      guardrail: "llm-judge",
      label: this.label,
      model: this.client.model,
      stage,
      ...(toolName ? { toolName } : {}),
    };
    try {
      const result = await this.client.classify({
        system,
        user,
        ...(signal ? { signal } : {}),
      });
      const raw = result.text.trim().toLowerCase();
      const usage = this.usageFromResult(result.usage);
      for (const label of labels) {
        if (raw.startsWith(label.toLowerCase())) {
          logger.debug(
            {
              ...logCtx,
              verdict: label,
              tokensIn: usage?.tokensIn,
              tokensOut: usage?.tokensOut,
              costCents: usage?.costCents,
              durMs: Date.now() - startedAt,
            },
            "guardrail: llm-judge classified",
          );
          return { verdict: label, usage };
        }
      }
      logger.warn(
        {
          ...logCtx,
          rawSample: raw.slice(0, 32),
          tokensIn: usage?.tokensIn,
          tokensOut: usage?.tokensOut,
          durMs: Date.now() - startedAt,
        },
        "guardrail: llm-judge unparseable verdict (allowing by default)",
      );
      return { verdict: null, usage };
    } catch (err) {
      logger.warn(
        { ...logCtx, durMs: Date.now() - startedAt, ...errFields(err) },
        "guardrail: llm-judge call failed (allowing by default)",
      );
      return { verdict: null, usage: undefined };
    }
  }

  private usageFromResult(
    raw: { tokensIn: number; tokensOut: number } | undefined,
  ): GuardrailUsage | undefined {
    if (!raw) return undefined;
    const tokensIn = raw.tokensIn ?? 0;
    const tokensOut = raw.tokensOut ?? 0;
    if (tokensIn === 0 && tokensOut === 0) return undefined;
    const costCents = this.computeCostCents(tokensIn, tokensOut);
    return costCents !== undefined ? { tokensIn, tokensOut, costCents } : { tokensIn, tokensOut };
  }

  private computeCostCents(tokensIn: number, tokensOut: number): number | undefined {
    if (this.inputPriceCentsPerMtok === null && this.outputPriceCentsPerMtok === null) {
      return undefined;
    }
    const inCents = ((this.inputPriceCentsPerMtok ?? 0) * tokensIn) / 1_000_000;
    const outCents = ((this.outputPriceCentsPerMtok ?? 0) * tokensOut) / 1_000_000;
    return inCents + outCents;
  }
}

function withUsage(
  decision: GuardrailDecision,
  usage: GuardrailUsage | undefined,
): GuardrailDecision {
  if (!usage) return decision;
  return { ...decision, usage } as GuardrailDecision;
}

/**
 * Sum two usage blocks. Used by self-consistency in `checkToolResult` to
 * bill the operator for both the first and the confirmation classify
 * calls. Either side may be undefined (failed call → no usage surfaced).
 */
function mergeUsage(
  a: GuardrailUsage | undefined,
  b: GuardrailUsage | undefined,
): GuardrailUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const tokensIn = a.tokensIn + b.tokensIn;
  const tokensOut = a.tokensOut + b.tokensOut;
  if (a.costCents === undefined && b.costCents === undefined) {
    return { tokensIn, tokensOut };
  }
  return { tokensIn, tokensOut, costCents: (a.costCents ?? 0) + (b.costCents ?? 0) };
}
