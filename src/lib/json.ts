/**
 * Narrow an unknown value (typically a JSON column read or an external
 * payload) to a plain `Record<string, unknown>` for property access.
 * Returns `{}` when the value is null, an array, or a primitive — callers
 * don't need to branch on shape every time they read out of a JSON column.
 *
 * Use at the boundary where DB JSON columns or external payloads enter
 * typed code; downstream code can keep treating the result as a record
 * without sprinkling `as Record<string, unknown>` casts.
 */
export function asPlainObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Narrow an unknown value to `Record<string, string>` if every entry is a
 * string; otherwise return `null`. Use for parsed JSON payloads where the
 * caller wants to surface a typed object or report a validation error.
 */
export function parseStringMap(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}
