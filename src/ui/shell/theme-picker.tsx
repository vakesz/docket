"use client";

import { useEffect, useState } from "react";
import {
  ADAPTIVE_VARIANTS,
  applyTheme,
  isAdaptiveTheme,
  readStoredTheme,
  THEMES,
  type ThemeId,
  writeStoredTheme,
} from "@/lib/theme";

/**
 * Theme switcher that mirrors main's pattern: localStorage-backed,
 * grouped Adaptive/Light/Dark, watches `prefers-color-scheme` so adaptive
 * themes flip with the OS without a refresh.
 */
export function ThemePicker() {
  const [theme, setTheme] = useState<ThemeId>("system");

  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);

  useEffect(() => {
    if (!isAdaptiveTheme(theme)) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme(theme);
    handler();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  function onPick(next: ThemeId): void {
    setTheme(next);
    writeStoredTheme(next);
    applyTheme(next);
  }

  const adaptive = THEMES.filter((t) => t.group === "adaptive");
  const light = THEMES.filter((t) => t.group === "light");
  const dark = THEMES.filter((t) => t.group === "dark");

  return (
    <label className="flex items-center gap-1 text-xs">
      <span className="text-xs uppercase tracking-wide text-fg-faint">Theme</span>
      <select
        value={theme}
        onChange={(e) => onPick(e.target.value as ThemeId)}
        className="rounded border border-border bg-surface px-2 py-0.5 text-xs text-fg focus:border-accent focus:outline-none"
        aria-label="Color theme"
      >
        <optgroup label="Adaptive">
          {adaptive.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
              {isAdaptiveTheme(t.id)
                ? ` (${ADAPTIVE_VARIANTS[t.id].light} / ${ADAPTIVE_VARIANTS[t.id].dark})`
                : ""}
            </option>
          ))}
        </optgroup>
        <optgroup label="Light">
          {light.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Dark">
          {dark.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}
