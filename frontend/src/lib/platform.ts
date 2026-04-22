/**
 * Small platform helpers for keyboard-shortcut affordances.
 *
 * We don't detect platform for functional behavior — everywhere we listen for a
 * modifier we accept *both* ctrl and meta — only for rendering the "press X"
 * hint. On SSR we fall back to a cross-platform label.
 */

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.platform || navigator.userAgent || "";
  return /Mac|iPhone|iPad|iPod/i.test(ua);
}

export function modKeyLabel(): string {
  return isMac() ? "⌘" : "Ctrl";
}

export function shortcut(label: string): string {
  return `${modKeyLabel()}${label.startsWith("+") ? "" : "+"}${label}`;
}
