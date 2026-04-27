"use client";

/**
 * Browser-local UI preferences.
 *
 * These deliberately bypass the Setting table — they're cosmetic,
 * device-specific, and shouldn't sync across machines. Tone matches
 * `lib/theme.ts`: tiny read/write functions plus a hook that subscribes
 * to a custom event so multiple mounts stay in sync without prop
 * drilling.
 *
 * Keep this list small. If a preference grows server-side semantics
 * (gates a feature, drives audit, etc.) promote it into the catalog.
 */

import { useEffect, useState } from "react";

export type ToolDisplayMode = "show" | "collapse" | "hide";

const TOOL_DISPLAY_KEY = "docket.chat.toolDisplay";
const VALID_MODES: ReadonlySet<string> = new Set(["show", "collapse", "hide"]);
const PREF_EVENT = "docket:uiprefs";

export function readToolDisplayMode(): ToolDisplayMode {
  if (typeof window === "undefined") return "collapse";
  const raw = window.localStorage.getItem(TOOL_DISPLAY_KEY);
  return raw && VALID_MODES.has(raw) ? (raw as ToolDisplayMode) : "collapse";
}

export function writeToolDisplayMode(value: ToolDisplayMode): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOOL_DISPLAY_KEY, value);
  window.dispatchEvent(new CustomEvent(PREF_EVENT));
}

export function useToolDisplayMode(): [ToolDisplayMode, (v: ToolDisplayMode) => void] {
  const [value, setValue] = useState<ToolDisplayMode>("collapse");

  useEffect(() => {
    setValue(readToolDisplayMode());
    const onChange = () => setValue(readToolDisplayMode());
    window.addEventListener("storage", onChange);
    window.addEventListener(PREF_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener(PREF_EVENT, onChange);
    };
  }, []);

  return [
    value,
    (next: ToolDisplayMode) => {
      writeToolDisplayMode(next);
      setValue(next);
    },
  ];
}
