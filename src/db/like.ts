/**
 * Escape user input before interpolating it into an ILIKE pattern.
 *
 * Postgres treats `%` and `_` as wildcards, and `\` as the escape
 * character (unless `ESCAPE ''` is specified). Without escaping, a user
 * who searches for `50%` matches every row, and a search for `_` matches
 * any single character. Wrap the escaped value in `%...%` for a contains
 * search.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
