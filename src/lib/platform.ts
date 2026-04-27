/**
 * Tiny browser-side helpers for keyboard shortcut labels and modifiers.
 *
 * These are SSR-safe: when `navigator` isn't defined we fall back to the
 * non-Mac variant so the server-rendered HTML matches what most clients
 * see, then the client picks the right glyph after hydration.
 */

export function isMacLike(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.platform || navigator.userAgent || "";
  return /Mac|iPhone|iPad|iPod/i.test(ua);
}

export function shortcut(label: string): string {
  const mod = isMacLike() ? "⌘" : "Ctrl";
  return `${mod}${label.startsWith("+") ? "" : "+"}${label}`;
}
