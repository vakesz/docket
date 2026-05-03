/**
 * Per-vendor cost estimation lives here so the OpenAI and Anthropic
 * adapters share one formula. Both adapters store prices as USD cents per
 * million tokens (matches the `LlmProvider.{input,output}PriceCentsPerMtok`
 * decimal columns); cost is rounded to whole cents to match how
 * `Conversation.costCents` is summed downstream.
 *
 * Returns `undefined` when either price is missing — the adapter then
 * omits costCents from its `usage` event so callers can distinguish
 * "we don't know" from "the call was free."
 */
export function estimateCostCents(args: {
  tokensIn: number;
  tokensOut: number;
  inputPriceCentsPerMtok: number | undefined;
  outputPriceCentsPerMtok: number | undefined;
}): number | undefined {
  if (args.inputPriceCentsPerMtok === undefined || args.outputPriceCentsPerMtok === undefined) {
    return undefined;
  }
  return Math.round(
    (args.tokensIn * args.inputPriceCentsPerMtok + args.tokensOut * args.outputPriceCentsPerMtok) /
      1_000_000,
  );
}
