// Centralized theme catalog so the bootstrap script, the picker, and the
// settings page all agree on what's valid.
//
// `system` is special: it resolves to `light` or `dark` at apply time based
// on the OS preference. Every other entry is an explicit pick.
//
// `dark: true` means: toggle the `dark` class on <html> when this theme is
// active. That keeps Tailwind's `dark:` variant working for components that
// haven't been migrated to per-theme CSS variables.

export type ThemeId =
  | "system"
  | "light"
  | "dark"
  | "nord"
  | "dracula"
  | "gruvbox-dark"
  | "gruvbox-light"
  | "tokyo-night"
  | "catppuccin-mocha"
  | "catppuccin-latte"
  | "solarized-light";

export interface Theme {
  id: ThemeId;
  label: string;
  dark: boolean;
}

// `system` is omitted from this list because its dark/light flag depends on
// the OS at runtime; resolveTheme handles it explicitly.
export const THEMES: readonly Theme[] = [
  { id: "system", label: "System", dark: false },
  { id: "light", label: "Light", dark: false },
  { id: "dark", label: "Dark", dark: true },
  { id: "nord", label: "Nord", dark: true },
  { id: "dracula", label: "Dracula", dark: true },
  { id: "gruvbox-dark", label: "Gruvbox Dark", dark: true },
  { id: "gruvbox-light", label: "Gruvbox Light", dark: false },
  { id: "tokyo-night", label: "Tokyo Night", dark: true },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", dark: true },
  { id: "catppuccin-latte", label: "Catppuccin Latte", dark: false },
  { id: "solarized-light", label: "Solarized Light", dark: false },
];

export const STORAGE_KEY = "docket.theme";

const VALID_IDS: ReadonlySet<string> = new Set(THEMES.map((t) => t.id));

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return typeof value === "string" && VALID_IDS.has(value);
}

export function readStoredTheme(): ThemeId {
  if (typeof window === "undefined") return "system";
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return isThemeId(raw) ? raw : "system";
}

/** Resolve `system` to `light` or `dark` based on OS preference; pass others through. */
export function resolveTheme(id: ThemeId): Exclude<ThemeId, "system"> {
  if (id !== "system") return id;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Apply the resolved theme to <html>. Sets `data-theme` (consumed by the CSS
 * blocks in globals.css) and toggles the `dark` Tailwind class to match.
 */
export function applyTheme(id: ThemeId): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(id);
  const meta = THEMES.find((t) => t.id === resolved);
  const isDark = meta?.dark ?? false;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.classList.toggle("dark", isDark);
}
