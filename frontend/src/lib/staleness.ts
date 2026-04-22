type ConfigMap = Record<string, unknown>;

export type FreshnessTone = "fresh" | "warning" | "stale";

const DEFAULT_STALE_THRESHOLD_DAYS = 7;

function asRecord(value: unknown): ConfigMap | null {
  return value && typeof value === "object" ? (value as ConfigMap) : null;
}

function asWholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : null;
}

export function resolveStaleThreshold(
  config: ConfigMap | undefined,
  providerKey?: string | null,
): number | null {
  const stale = asRecord(config?.stale);
  const globalThreshold = asWholeNumber(stale?.threshold_days) ?? DEFAULT_STALE_THRESHOLD_DAYS;
  const overrides = asRecord(stale?.threshold_days_by_provider);
  const providerThreshold = providerKey && overrides ? asWholeNumber(overrides[providerKey]) : null;
  const threshold = providerThreshold ?? globalThreshold;
  return threshold > 0 ? threshold : null;
}

export function ageDays(updatedAt: string | null | undefined, nowMs = Date.now()): number | null {
  if (!updatedAt) return null;
  const thenMs = new Date(updatedAt).getTime();
  if (Number.isNaN(thenMs)) return null;
  return Math.max(0, Math.floor((nowMs - thenMs) / 86_400_000));
}

export function freshnessTone(
  updatedAt: string | null | undefined,
  thresholdDays: number | null | undefined,
  nowMs = Date.now(),
): FreshnessTone {
  const age = ageDays(updatedAt, nowMs);
  if (age === null || !thresholdDays || thresholdDays <= 0) return "fresh";
  if (age >= thresholdDays * 2) return "stale";
  if (age >= thresholdDays) return "warning";
  return "fresh";
}
