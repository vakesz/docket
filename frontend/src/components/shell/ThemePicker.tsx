import { useEffect, useMemo, useState } from "react";

import {
  ADAPTIVE_VARIANTS,
  applyTheme,
  readStoredTheme,
  STORAGE_KEY,
  THEMES,
  type ThemeId,
} from "~/lib/theme";

/**
 * Compact theme picker (rendered from Settings).
 *
 * Persists to localStorage and applies on every change. For any adaptive
 * theme (anything in ADAPTIVE_VARIANTS), we also watch `prefers-color-scheme`
 * so the variant flips live when the OS toggles. The inline bootstrap in
 * __root.tsx has already painted the correct theme before hydration, so the
 * initial state is intentionally `system` to keep SSR and first-paint in sync
 * — the first effect reads the real saved id from localStorage.
 *
 * Themes are grouped into Adaptive / Light / Dark optgroups so the user can
 * scan the list by mode.
 */
export function ThemePicker() {
  const [theme, setTheme] = useState<ThemeId>("system");
  // Gate the persist/apply effect until the stored theme has been read.
  // Without this, the first mount runs the effect with the placeholder
  // `system` and wipes the saved theme from localStorage (visible under
  // React Strict Mode, where the read effect re-runs after the wipe and
  // sees an empty store).
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setTheme(readStoredTheme());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    applyTheme(theme);
    if (theme in ADAPTIVE_VARIANTS) {
      if (theme === "system") {
        // No persisted value — `readStoredTheme` falls back to `system` on next visit.
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, theme);
      }
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => applyTheme(theme);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme, hydrated]);

  const groups = useMemo(() => {
    const adaptive = THEMES.filter((t) => t.category === "adaptive");
    const light = THEMES.filter((t) => t.category === "light");
    const dark = THEMES.filter((t) => t.category === "dark");
    return { adaptive, light, dark };
  }, []);

  return (
    <label className="flex items-center gap-1 text-xs">
      <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">Theme</span>
      <select
        value={theme}
        onChange={(e) => setTheme(e.target.value as ThemeId)}
        className="rounded border border-border bg-surface px-2 py-0.5 text-xs text-fg focus:border-accent focus:outline-none"
      >
        <optgroup label="Adaptive">
          {groups.adaptive.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Light">
          {groups.light.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Dark">
          {groups.dark.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}
