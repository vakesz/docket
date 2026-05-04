/**
 * Provider-agnostic tag/label merging. Both the GitHub `mergeLabels` and the
 * Azure DevOps `mergeTags` boil down to: drop case-insensitively from
 * `current`, then add `toAdd`, dedupe, sort. Pulled into core so the two
 * provider state-maps share one implementation without leaking provider
 * shapes back here.
 */
export function mergeStringSet(
  current: readonly string[],
  toRemove: readonly string[],
  toAdd: readonly string[],
): string[] {
  const removeSet = new Set(toRemove.map((t) => t.toLowerCase()));
  const out = new Set<string>();
  for (const tag of current) {
    if (!tag) continue;
    if (removeSet.has(tag.toLowerCase())) continue;
    out.add(tag);
  }
  for (const tag of toAdd) {
    out.add(tag);
  }
  return Array.from(out).sort();
}
