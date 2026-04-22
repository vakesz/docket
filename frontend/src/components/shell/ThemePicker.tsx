import { useEffect, useState } from "react";

import { applyTheme, readStoredTheme, STORAGE_KEY, THEMES, type ThemeId } from "~/lib/theme";

/**
 * Compact theme picker (rendered from Settings).
 *
 * Persists to localStorage and applies on every change (incl. live OS-preference
 * flips when `system` is selected). Initial render uses `system` so SSR and
 * the first client paint agree — the inline bootstrap in __root.tsx has
 * already painted the real theme. The first effect then loads the user's
 * saved choice.
 */
export function ThemePicker() {
  const [theme, setTheme] = useState<ThemeId>("system");

  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);

  useEffect(() => {
    applyTheme(theme);
    if (theme === "system") {
      // No persisted value — `readStoredTheme` falls back to `system` on next visit.
      window.localStorage.removeItem(STORAGE_KEY);
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => applyTheme("system");
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return (
    <label className="flex items-center gap-1 text-xs">
      <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">Theme</span>
      <select
        value={theme}
        onChange={(e) => setTheme(e.target.value as ThemeId)}
        className="rounded border border-border bg-surface px-2 py-0.5 text-xs text-fg focus:border-accent focus:outline-none"
      >
        {THEMES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}
