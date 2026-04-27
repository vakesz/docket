/**
 * Pure helpers for "is this item stale?" tone math.
 *
 * `resolveStaleThreshold` reads the global `items.stale-after-days` Setting
 * (with a sensible default), and `freshnessTone` translates an `updatedAt`
 * timestamp into a `fresh | warning | stale` bucket so list rows and
 * detail headers can paint themselves accordingly.
 *
 * Pure module — no I/O, no Prisma, no React.
 */

export type FreshnessTone = "fresh" | "warning" | "stale";

export const DEFAULT_STALE_THRESHOLD_DAYS = 7;

function asWholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : null;
}

/**
 * Resolve the active stale threshold (in days) from the global Setting
 * value. Anything <= 0 disables the stale tone entirely (returns null).
 */
export function resolveStaleThreshold(rawSetting: unknown): number | null {
  const v = asWholeNumber(rawSetting) ?? DEFAULT_STALE_THRESHOLD_DAYS;
  return v > 0 ? v : null;
}

export function ageDays(
  updatedAt: Date | string | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!updatedAt) return null;
  const thenMs =
    typeof updatedAt === "string" ? new Date(updatedAt).getTime() : updatedAt.getTime();
  if (Number.isNaN(thenMs)) return null;
  return Math.max(0, Math.floor((nowMs - thenMs) / 86_400_000));
}

/**
 * Three-band freshness: at >= 1× threshold, the row is "warning" (aging);
 * at >= 2× threshold it's "stale". Below threshold, "fresh" — which the UI
 * usually paints as "no decoration."
 */
export function freshnessTone(
  updatedAt: Date | string | null | undefined,
  thresholdDays: number | null | undefined,
  nowMs = Date.now(),
): FreshnessTone {
  const age = ageDays(updatedAt, nowMs);
  if (age === null || !thresholdDays || thresholdDays <= 0) return "fresh";
  if (age >= thresholdDays * 2) return "stale";
  if (age >= thresholdDays) return "warning";
  return "fresh";
}
