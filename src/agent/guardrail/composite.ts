/**
 * Composite guardrail — runs adapters in series, cheap-first.
 *
 * Order:
 *   1. PatternGuardrail  — local regex, no network. Free, ~microseconds.
 *   2. LlmJudgeGuardrail — calls the operator-configured guardrail
 *                          provider row. ~$0.0002 per call.
 *
 * Short-circuits on the first non-`allow` decision: a pattern `block`
 * skips the LLM judge entirely. A pattern `flag` is escalated only when
 * the judge would have produced something stronger.
 *
 * The composite kind value (`"composite"`) shows up in
 * `Setting('guardrail.kind')` for projects that want both layers active.
 */

import type { CheckToolResultArgs, Guardrail, GuardrailDecision } from "@/agent/guardrail/types";

export class CompositeGuardrail implements Guardrail {
  readonly kind = "composite" as const;
  readonly label: string;
  private readonly chain: readonly Guardrail[];

  constructor(chain: readonly Guardrail[]) {
    if (chain.length === 0) {
      throw new Error("CompositeGuardrail requires at least one adapter");
    }
    this.chain = chain;
    this.label = `composite(${chain.map((g) => g.kind).join("+")})`;
  }

  async checkInput(text: string, signal?: AbortSignal): Promise<GuardrailDecision> {
    return runChain(this.chain, (g) => g.checkInput(text, signal));
  }

  async checkToolResult(
    args: CheckToolResultArgs,
    signal?: AbortSignal,
  ): Promise<GuardrailDecision> {
    return runChain(this.chain, (g) => g.checkToolResult(args, signal));
  }

  async checkOutput(text: string, signal?: AbortSignal): Promise<GuardrailDecision> {
    return runChain(this.chain, (g) => g.checkOutput(text, signal));
  }
}

async function runChain(
  chain: readonly Guardrail[],
  step: (g: Guardrail) => Promise<GuardrailDecision>,
): Promise<GuardrailDecision> {
  let highest: GuardrailDecision = { action: "allow" };
  let tokensIn = 0;
  let tokensOut = 0;
  let costCents: number | undefined;
  let sawCost = false;
  for (const adapter of chain) {
    const decision = await step(adapter);
    if (decision.usage) {
      tokensIn += decision.usage.tokensIn;
      tokensOut += decision.usage.tokensOut;
      if (decision.usage.costCents !== undefined) {
        costCents = (costCents ?? 0) + decision.usage.costCents;
        sawCost = true;
      }
    }
    if (decision.action === "block") {
      // Strongest signal wins, skip the rest. Fold accumulated usage from
      // earlier adapters (and this one) into the returned decision so the
      // operator gets billed for every call we actually made.
      return mergeUsage(decision, tokensIn, tokensOut, sawCost ? costCents : undefined);
    }
    if (decision.action === "flag" && highest.action === "allow") {
      highest = decision;
    }
  }
  return mergeUsage(highest, tokensIn, tokensOut, sawCost ? costCents : undefined);
}

function mergeUsage(
  decision: GuardrailDecision,
  tokensIn: number,
  tokensOut: number,
  costCents: number | undefined,
): GuardrailDecision {
  if (tokensIn === 0 && tokensOut === 0 && costCents === undefined) return decision;
  const usage =
    costCents !== undefined ? { tokensIn, tokensOut, costCents } : { tokensIn, tokensOut };
  return { ...decision, usage } as GuardrailDecision;
}
