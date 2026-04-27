/**
 * Theme catalog.
 *
 * "Concrete" themes have one fixed appearance. "Adaptive" themes follow the
 * OS's `prefers-color-scheme` and resolve to one concrete theme at apply
 * time. The browser stores either kind under STORAGE_KEY; the boot script
 * reads it before first paint to avoid a theme flash.
 *
 * Tokens for each concrete theme are declared in `src/app/globals.css` under
 * `:root[data-theme="..."]`. Keep this list and that file in sync — adding
 * a theme means a CSS block plus an entry here.
 */

export const STORAGE_KEY = "docket.theme";

export type ConcreteThemeId =
  | "light"
  | "dark"
  | "nord"
  | "dracula"
  | "gruvbox-dark"
  | "gruvbox-light"
  | "tokyo-night"
  | "catppuccin-mocha"
  | "catppuccin-latte"
  | "solarized-light"
  | "solarized-dark"
  | "monokai"
  | "catppuccin-frappe"
  | "catppuccin-macchiato"
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
  | "rose-pine-adaptive"
  | "solarized"
  | "github"
  | "atom-one"
  | "flexoki"
  | "ayu"
  | "everforest";

export type ThemeId = ConcreteThemeId | AdaptiveThemeId;

export type Theme = {
  id: ThemeId;
  label: string;
  group: "adaptive" | "light" | "dark";
};

/** Adaptive themes resolve to one of two concrete themes via prefers-color-scheme. */
export const ADAPTIVE_VARIANTS: Record<
  AdaptiveThemeId,
  { light: ConcreteThemeId; dark: ConcreteThemeId }
> = {
  system: { light: "light", dark: "dark" },
  catppuccin: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
  gruvbox: { light: "gruvbox-light", dark: "gruvbox-dark" },
  "rose-pine-adaptive": { light: "rose-pine-dawn", dark: "rose-pine" },
  solarized: { light: "solarized-light", dark: "solarized-dark" },
  github: { light: "github-light", dark: "github-dark" },
  "atom-one": { light: "atom-one-light", dark: "atom-one-dark" },
  flexoki: { light: "flexoki-light", dark: "flexoki-dark" },
  ayu: { light: "ayu-light", dark: "ayu-dark" },
  everforest: { light: "everforest-light", dark: "everforest-dark" },
};

export const THEMES: Theme[] = [
  { id: "system", label: "System", group: "adaptive" },
  { id: "catppuccin", label: "Catppuccin (adaptive)", group: "adaptive" },
  { id: "gruvbox", label: "Gruvbox (adaptive)", group: "adaptive" },
  { id: "rose-pine-adaptive", label: "Rosé Pine (adaptive)", group: "adaptive" },
  { id: "solarized", label: "Solarized (adaptive)", group: "adaptive" },
  { id: "github", label: "GitHub (adaptive)", group: "adaptive" },
  { id: "atom-one", label: "Atom One (adaptive)", group: "adaptive" },
  { id: "flexoki", label: "Flexoki (adaptive)", group: "adaptive" },
  { id: "ayu", label: "Ayu (adaptive)", group: "adaptive" },
  { id: "everforest", label: "Everforest (adaptive)", group: "adaptive" },

  { id: "light", label: "Light", group: "light" },
  { id: "catppuccin-latte", label: "Catppuccin Latte", group: "light" },
  { id: "gruvbox-light", label: "Gruvbox Light", group: "light" },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn", group: "light" },
  { id: "solarized-light", label: "Solarized Light", group: "light" },
  { id: "github-light", label: "GitHub Light", group: "light" },
  { id: "atom-one-light", label: "Atom One Light", group: "light" },
  { id: "flexoki-light", label: "Flexoki Light", group: "light" },
  { id: "ayu-light", label: "Ayu Light", group: "light" },
  { id: "everforest-light", label: "Everforest Light", group: "light" },

  { id: "dark", label: "Dark", group: "dark" },
  { id: "nord", label: "Nord", group: "dark" },
  { id: "dracula", label: "Dracula", group: "dark" },
  { id: "gruvbox-dark", label: "Gruvbox Dark", group: "dark" },
  { id: "tokyo-night", label: "Tokyo Night", group: "dark" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", group: "dark" },
  { id: "catppuccin-frappe", label: "Catppuccin Frappé", group: "dark" },
  { id: "catppuccin-macchiato", label: "Catppuccin Macchiato", group: "dark" },
  { id: "solarized-dark", label: "Solarized Dark", group: "dark" },
  { id: "monokai", label: "Monokai", group: "dark" },
  { id: "rose-pine", label: "Rosé Pine", group: "dark" },
  { id: "rose-pine-moon", label: "Rosé Pine Moon", group: "dark" },
  { id: "atom-one-dark", label: "Atom One Dark", group: "dark" },
  { id: "flexoki-dark", label: "Flexoki Dark", group: "dark" },
  { id: "github-dark", label: "GitHub Dark", group: "dark" },
  { id: "ayu-dark", label: "Ayu Dark (Mirage)", group: "dark" },
  { id: "everforest-dark", label: "Everforest Dark", group: "dark" },
];

const CONCRETE_IDS = new Set(THEMES.filter((t) => t.group !== "adaptive").map((t) => t.id));
const ADAPTIVE_IDS = new Set(Object.keys(ADAPTIVE_VARIANTS) as AdaptiveThemeId[]);

export function isAdaptiveTheme(id: string): id is AdaptiveThemeId {
  return ADAPTIVE_IDS.has(id as AdaptiveThemeId);
}

export function isValidTheme(id: string): id is ThemeId {
  return CONCRETE_IDS.has(id as ConcreteThemeId) || ADAPTIVE_IDS.has(id as AdaptiveThemeId);
}

const DARK_CONCRETE = new Set<ConcreteThemeId>(
  THEMES.filter((t) => t.group === "dark").map((t) => t.id as ConcreteThemeId),
);

export function resolveTheme(id: ThemeId): ConcreteThemeId {
  if (isAdaptiveTheme(id)) {
    const prefersDark =
      typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    return prefersDark ? ADAPTIVE_VARIANTS[id].dark : ADAPTIVE_VARIANTS[id].light;
  }
  return id;
}

/** Apply a theme to <html>. Sets data-theme to the resolved concrete id and
 * toggles the .dark class so legacy `dark:` Tailwind variants keep working. */
export function applyTheme(id: ThemeId): void {
  if (typeof document === "undefined") return;
  const concrete = resolveTheme(id);
  document.documentElement.dataset.theme = concrete;
  document.documentElement.classList.toggle("dark", DARK_CONCRETE.has(concrete));
}

export function readStoredTheme(): ThemeId {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && isValidTheme(raw)) return raw;
  } catch {
    // localStorage might be blocked (private mode, etc.) — fall through.
  }
  return "system";
}

export function writeStoredTheme(id: ThemeId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Ignore storage errors.
  }
}
