export function cn(...values: (string | number | false | null | undefined)[]): string {
  let out = "";
  for (const v of values) {
    if (!v && v !== 0) continue;
    out = out ? `${out} ${v}` : String(v);
  }
  return out;
}
