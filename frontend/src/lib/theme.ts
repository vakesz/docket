// Centralized theme catalog so the bootstrap script, the picker, and the
// settings page all agree on what's valid.
//
// Themes come in three flavors:
//   - "light" / "dark": explicit single-mode picks.
//   - "adaptive": pair of light + dark variants that follow the OS
//     `prefers-color-scheme`. Selecting one sets the adaptive id, and the
//     resolver picks the concrete data-theme at apply time.
//   - "system": system follows the OS and resolves to plain light/dark.
//
// All concrete (applied) themes have a matching block in globals.css keyed
// on `data-theme="..."`. The `dark: true` flag controls whether we toggle
// the `dark` Tailwind class for `dark:` variants on unmigrated components.

export type ConcreteThemeId =
  // Single-mode
  | "light"
  | "dark"
  | "nord"
  | "dracula"
  | "gruvbox-dark"
  | "gruvbox-light"
  | "tokyo-night"
  | "monokai"
  | "catppuccin-mocha"
  | "catppuccin-latte"
  | "catppuccin-frappe"
  | "catppuccin-macchiato"
  | "solarized-light"
  | "solarized-dark"
  | "rose-pine"
  | "rose-pine-moon"
  | "rose-pine-dawn"
  | "atom-one-dark"
  | "atom-one-light"
  | "flexoki-dark"
  | "flexoki-light"
  | "github-light"
  | "github-dark"
  | "ayu-light"
  | "ayu-dark"
  | "everforest-light"
  | "everforest-dark";

export type AdaptiveThemeId =
  | "system"
  | "catppuccin"
  | "gruvbox"
  | "solarized"
  | "rose-pine-auto"
  | "atom-one"
  | "flexoki"
  | "github"
  | "ayu"
  | "everforest";

export type ThemeId = ConcreteThemeId | AdaptiveThemeId;

export type ThemeCategory = "light" | "dark" | "adaptive";

export interface Theme {
  id: ThemeId;
  label: string;
  category: ThemeCategory;
  /** Toggle the `dark` class on <html>. For adaptive themes, determined at resolve time. */
  dark: boolean;
}

export const THEMES: readonly Theme[] = [
  // Adaptive (follow OS preference)
  { id: "system", label: "System", category: "adaptive", dark: false },
  { id: "catppuccin", label: "Catppuccin (Auto)", category: "adaptive", dark: false },
  { id: "gruvbox", label: "Gruvbox (Auto)", category: "adaptive", dark: false },
  { id: "solarized", label: "Solarized (Auto)", category: "adaptive", dark: false },
  { id: "rose-pine-auto", label: "Rosé Pine (Auto)", category: "adaptive", dark: false },
  { id: "atom-one", label: "Atom One (Auto)", category: "adaptive", dark: false },
  { id: "flexoki", label: "Flexoki (Auto)", category: "adaptive", dark: false },
  { id: "github", label: "GitHub (Auto)", category: "adaptive", dark: false },
  { id: "ayu", label: "Ayu (Auto)", category: "adaptive", dark: false },
  { id: "everforest", label: "Everforest (Auto)", category: "adaptive", dark: false },

  // Light
  { id: "light", label: "Light", category: "light", dark: false },
  { id: "gruvbox-light", label: "Gruvbox Light", category: "light", dark: false },
  { id: "catppuccin-latte", label: "Catppuccin Latte", category: "light", dark: false },
  { id: "solarized-light", label: "Solarized Light", category: "light", dark: false },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn", category: "light", dark: false },
  { id: "atom-one-light", label: "Atom One Light", category: "light", dark: false },
  { id: "flexoki-light", label: "Flexoki Light", category: "light", dark: false },
  { id: "github-light", label: "GitHub Light", category: "light", dark: false },
  { id: "ayu-light", label: "Ayu Light", category: "light", dark: false },
  { id: "everforest-light", label: "Everforest Light", category: "light", dark: false },

  // Dark
  { id: "dark", label: "Dark", category: "dark", dark: true },
  { id: "nord", label: "Nord", category: "dark", dark: true },
  { id: "dracula", label: "Dracula", category: "dark", dark: true },
  { id: "gruvbox-dark", label: "Gruvbox Dark", category: "dark", dark: true },
  { id: "tokyo-night", label: "Tokyo Night", category: "dark", dark: true },
  { id: "monokai", label: "Monokai", category: "dark", dark: true },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", category: "dark", dark: true },
  { id: "catppuccin-frappe", label: "Catppuccin Frappé", category: "dark", dark: true },
  { id: "catppuccin-macchiato", label: "Catppuccin Macchiato", category: "dark", dark: true },
  { id: "solarized-dark", label: "Solarized Dark", category: "dark", dark: true },
  { id: "rose-pine", label: "Rosé Pine", category: "dark", dark: true },
  { id: "rose-pine-moon", label: "Rosé Pine Moon", category: "dark", dark: true },
  { id: "atom-one-dark", label: "Atom One Dark", category: "dark", dark: true },
  { id: "flexoki-dark", label: "Flexoki Dark", category: "dark", dark: true },
  { id: "github-dark", label: "GitHub Dark", category: "dark", dark: true },
  { id: "ayu-dark", label: "Ayu Dark", category: "dark", dark: true },
  { id: "everforest-dark", label: "Everforest Dark", category: "dark", dark: true },
];

/** Light+dark variant for each adaptive theme. */
export const ADAPTIVE_VARIANTS: Record<
  AdaptiveThemeId,
  { light: ConcreteThemeId; dark: ConcreteThemeId }
> = {
  system: { light: "light", dark: "dark" },
  catppuccin: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
  gruvbox: { light: "gruvbox-light", dark: "gruvbox-dark" },
  solarized: { light: "solarized-light", dark: "solarized-dark" },
  "rose-pine-auto": { light: "rose-pine-dawn", dark: "rose-pine" },
  "atom-one": { light: "atom-one-light", dark: "atom-one-dark" },
  flexoki: { light: "flexoki-light", dark: "flexoki-dark" },
  github: { light: "github-light", dark: "github-dark" },
  ayu: { light: "ayu-light", dark: "ayu-dark" },
  everforest: { light: "everforest-light", dark: "everforest-dark" },
};

export const STORAGE_KEY = "docket.theme";

const VALID_IDS: ReadonlySet<string> = new Set(THEMES.map((t) => t.id));

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return typeof value === "string" && VALID_IDS.has(value);
}

function isAdaptive(id: ThemeId): id is AdaptiveThemeId {
  return id in ADAPTIVE_VARIANTS;
}

export function readStoredTheme(): ThemeId {
  if (typeof window === "undefined") return "system";
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return isThemeId(raw) ? raw : "system";
}

/** Resolve adaptive ids to their concrete light/dark variant; pass concrete ids through. */
export function resolveTheme(id: ThemeId): ConcreteThemeId {
  if (isAdaptive(id)) {
    const prefersDark =
      typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? ADAPTIVE_VARIANTS[id].dark : ADAPTIVE_VARIANTS[id].light;
  }
  return id;
}

/**
 * Apply the resolved theme to <html>. Sets `data-theme` (consumed by the CSS
 * blocks in globals.css) and toggles the `dark` Tailwind class to match.
 */
export function applyTheme(id: ThemeId): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(id);
  const meta = THEMES.find((t) => t.id === resolved);
  const isDark = meta?.category === "dark";
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.classList.toggle("dark", isDark);
}
