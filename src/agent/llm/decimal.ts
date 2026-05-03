/**
 * Drizzle `decimal` columns surface in JS as `string | null` (Postgres
 * numeric, preserved as string for precision). The chat-side and
 * guardrail-side LLM registries both want `number | null` for prices,
 * with a finiteness guard so a malformed row can't poison cost math
 * downstream.
 */
export function decimalToNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
