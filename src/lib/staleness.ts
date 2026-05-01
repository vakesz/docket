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

/**
 * Resolve the effective stale threshold from the per-user override and the
 * per-project default. The user value uses a sentinel encoding:
 *  - `-1`  → inherit the project value
 *  - `0`   → force-disabled for me on every project
 *  - `>0`  → my personal threshold wins over the project value
 *
 * Project value is a normal `>= 0` integer (`0` disables the tint for the
 * whole project). Returns `null` when the tint should be hidden, otherwise a
 * positive day count.
 */
export function resolveEffectiveStaleThreshold(
  userValue: number | null | undefined,
  projectValue: number | null | undefined,
): number | null {
  if (typeof userValue === "number" && Number.isFinite(userValue) && userValue >= 0) {
    return userValue > 0 ? Math.trunc(userValue) : null;
  }
  if (typeof projectValue === "number" && Number.isFinite(projectValue) && projectValue >= 0) {
    return projectValue > 0 ? Math.trunc(projectValue) : null;
  }
  return DEFAULT_STALE_THRESHOLD_DAYS;
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
