export function pctChange(older: number, recent: number): number | null {
  if (older === 0 && recent === 0) return 0;
  if (older === 0) return null;
  return ((recent - older) / older) * 100;
}

export function formatDelta(pct: number | null): string {
  if (pct === null) return "n/a";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

export function shortNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

// YYYY-MM-DD → MM-DD
export function shortDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(5) : iso;
}
