/**
 * Guardrail interface — vendor-neutral, mirrors the LLM adapter shape.
 *
 * The agent loop never imports a guardrail vendor SDK directly; it only
 * sees a `Guardrail` instance handed back by `selectGuardrailFor`.
 * Three hook points sit inside the loop:
 *
 *   1. `checkInput`  — runs after the user message is persisted, before
 *                      transcript assembly. A `block` aborts the turn.
 *   2. `checkToolResult` — runs after each tool dispatch, before the
 *                          result is re-fed to the model. A `block`
 *                          replaces the result with a refusal stub the
 *                          model can react to (it never sees the original
 *                          payload). A `flag` prepends a warning line.
 *   3. `checkOutput` — runs after the final assistant text is persisted,
 *                      before `done`. Output is never blocked mid-stream
 *                      (UX cost too high); `flag` only marks the row.
 *
 * Architecture rule: only files under `src/agent/guardrail/**` may import
 * vendor SDKs needed by guardrail adapters. Enforced by
 * `src/__arch__/no-llm-vendor-leak.test.ts` (guardrail/ is allow-listed
 * alongside llm/).
 */

export const GUARDRAIL_KINDS = ["noop", "pattern", "llm-judge", "composite"] as const;
export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];

export type GuardrailStage = "input" | "tool_result" | "output";

/**
 * Token + cost accounting for a single guardrail check. Adapters that hit
 * an LLM (the LLM-judge) populate this; cheap pattern / no-op adapters
 * leave it undefined. The loop folds these into per-conversation
 * `guardrailTokensIn / guardrailTokensOut / guardrailCostCents` columns so
 * analytics can split guardrail spend from chat spend without changing
 * the LlmProvider schema.
 */
export type GuardrailUsage = {
  tokensIn: number;
  tokensOut: number;
  /** USD cents, when the adapter can compute it from the row's pricing. */
  costCents?: number;
};

export type GuardrailDecision = (
  | { action: "allow" }
  | { action: "flag"; reason: string; categories?: readonly string[] }
  | { action: "block"; reason: string; categories?: readonly string[] }
) & { usage?: GuardrailUsage };

export type CheckToolResultArgs = {
  toolName: string;
  /**
   * The structured result already produced by the tool. Adapters typically
   * inspect `.data` (or its stringified form) rather than `.ok`.
   */
  result: unknown;
};

export interface Guardrail {
  readonly kind: GuardrailKind;
  /** Display label for log lines / UI. */
  readonly label: string;

  checkInput(text: string, signal?: AbortSignal): Promise<GuardrailDecision>;
  checkToolResult(args: CheckToolResultArgs, signal?: AbortSignal): Promise<GuardrailDecision>;
  checkOutput(text: string, signal?: AbortSignal): Promise<GuardrailDecision>;
}

/**
 * Helper: extract a stringified payload from a tool's structured result so
 * adapters can scan it. Tools return `{ ok, data?, error? }`; `data` is
 * the part originating outside the trust boundary (web_fetch markdown,
 * GitHub comment bodies, MCP responses).
 */
export function stringifyToolResult(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  try {
    const r = result as { data?: unknown; error?: unknown };
    if (r.data !== undefined) {
      return typeof r.data === "string" ? r.data : JSON.stringify(r.data);
    }
    if (r.error !== undefined) {
      return typeof r.error === "string" ? r.error : JSON.stringify(r.error);
    }
    return JSON.stringify(result);
  } catch {
    return "";
  }
}
