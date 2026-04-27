/**
 * Parse "$ per Mtok" form input into cents-per-Mtok for the router/mutation.
 * Accepts both "1.25" and "1,25" — the comma is the decimal separator in
 * many European locales and would otherwise silently parse as NaN → null.
 */
export function parsePriceDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed.length === 0) return null;
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

/** Render a stored cents-per-Mtok value as a dollar string for the form. */
export function formatPriceCentsAsDollars(cents: number | null | undefined): string {
  if (typeof cents !== "number") return "";
  return (cents / 100).toFixed(2);
}
