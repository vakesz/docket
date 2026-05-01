/**
 * Token-level similarity helpers shared across recommendation paths.
 *
 * Used by the "comment echoes description" advisory in
 * `proposeComment` and by the duplicate-detection recommendation flow.
 * Pure string-in / number-out — no DB, no LLM, no I/O.
 */

import "server-only";

/**
 * Lowercase, split on non-alphanumeric, drop tokens shorter than 3 chars
 * to keep stop-words ("the", "and") from anchoring scores.
 */
export function tokenize(input: string): Set<string> {
  const matches = input.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(matches.filter((t) => t.length >= 3));
}

/**
 * Jaccard index over the tokenized form of `a` and `b`. Returns a value
 * in `[0, 1]`. Empty inputs (or strings that tokenize to nothing) score
 * `0` — the caller decides how to interpret that.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Score a candidate item against the current item for duplicate
 * detection. Combines title and description into a single token bag so a
 * close match on either side bumps the score, then applies Jaccard.
 *
 * The threshold itself is project-scoped
 * (`recommendations.duplicate-detection.similarity-threshold`) and lives
 * in the catalog; this helper just produces the raw score.
 */
export function scoreItemPair(
  a: { title: string; description: string },
  b: { title: string; description: string },
): number {
  const left = `${a.title}\n${a.description}`;
  const right = `${b.title}\n${b.description}`;
  return jaccardSimilarity(left, right);
}
