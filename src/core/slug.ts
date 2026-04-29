/**
 * URL slug derivation for human-named entities.
 *
 * `slugify` is the single canonical rule: lowercase, strip diacritics, fold
 * non-alphanumeric runs to a single `-`, and trim leading/trailing dashes.
 * Returns null when the input contains nothing slug-worthy (e.g. only
 * punctuation), so callers reject the rename rather than silently producing
 * an empty string.
 */

const NON_ALPHANUMERIC_RUN = /[^a-z0-9]+/g;
// Combining marks (Unicode category Mn) — produced by NFKD when peeling
// diacritics off base letters ("é" → "e" + ◌́).
const COMBINING_MARKS = /\p{M}+/gu;

export function slugify(name: string): string | null {
  const folded = name.toLowerCase().normalize("NFKD").replace(COMBINING_MARKS, "");
  const slug = folded.replace(NON_ALPHANUMERIC_RUN, "-").replace(/^-+|-+$/g, "");
  return slug.length === 0 ? null : slug;
}
