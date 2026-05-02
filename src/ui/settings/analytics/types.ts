export type Bucket = {
  date: string;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  guardrailTokensIn: number;
  guardrailTokensOut: number;
  guardrailCostCents: number;
  conversations: number;
};

export type DailyTotals = {
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  guardrailTokensIn: number;
  guardrailTokensOut: number;
  guardrailCostCents: number;
  conversations: number;
};
