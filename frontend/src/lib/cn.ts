/**
 * Tiny classname concatenator. Avoids pulling clsx/classnames — all we need is
 * null/undefined/false filtering with a single space join.
 */
export function cn(...values: (string | number | false | null | undefined)[]): string {
  let out = "";
  for (const v of values) {
    if (!v && v !== 0) continue;
    out = out ? `${out} ${v}` : String(v);
  }
  return out;
}
