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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";

/**
 * Theme switcher that mirrors main's pattern: localStorage-backed,
 * grouped Adaptive/Light/Dark, watches `prefers-color-scheme` so adaptive
 * themes flip with the OS without a refresh.
 */
export function ThemePicker() {
  const [theme, setTheme] = useState<ThemeId>("system");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setTheme(readStoredTheme());
    setLoaded(true);
  }, []);

  // Boot script (theme-boot-script.tsx) applies the stored theme before
  // hydration, so we don't re-apply on mount — that would override the
  // user's choice with the placeholder "system" before the stored value
  // is loaded. Only the matchMedia listener needs to drive applyTheme.
  useEffect(() => {
    if (!loaded) return;
    if (!isAdaptiveTheme(theme)) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme(theme);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [loaded, theme]);

  function onPick(next: ThemeId): void {
    setTheme(next);
    writeStoredTheme(next);
    applyTheme(next);
  }

  const adaptive = THEMES.filter((t) => t.group === "adaptive");
  const light = THEMES.filter((t) => t.group === "light");
  const dark = THEMES.filter((t) => t.group === "dark");

  return (
    <Select value={theme} onValueChange={(v) => onPick(v as ThemeId)}>
      <SelectTrigger aria-label="Color theme" className="w-full max-w-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Adaptive</SelectLabel>
          {adaptive.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.label}
              {isAdaptiveTheme(t.id)
                ? ` (${ADAPTIVE_VARIANTS[t.id].light} / ${ADAPTIVE_VARIANTS[t.id].dark})`
                : ""}
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel>Light</SelectLabel>
          {light.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.label}
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel>Dark</SelectLabel>
          {dark.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
