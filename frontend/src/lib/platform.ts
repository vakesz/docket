export function shortcut(label: string): string {
  const ua =
    typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent || "";
  const mod = /Mac|iPhone|iPad|iPod/i.test(ua) ? "⌘" : "Ctrl";
  return `${mod}${label.startsWith("+") ? "" : "+"}${label}`;
}
