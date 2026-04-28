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

const RECENT_LIMIT_KEY = "docket.items.recentLimit";
const RECENT_LIMIT_DEFAULT = 5;
export const RECENT_LIMIT_MAX = 20;

const RECENT_ENABLED_KEY = "docket.items.recentEnabled";
const RECENT_ENABLED_DEFAULT = true;

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

/**
 * How many recently-viewed items to surface at the top of the backlog pane.
 * `0` disables the Recent section entirely. Stored per-device (browser-local)
 * because the recent ids themselves are.
 */
export function readRecentLimit(): number {
  if (typeof window === "undefined") return RECENT_LIMIT_DEFAULT;
  const raw = window.localStorage.getItem(RECENT_LIMIT_KEY);
  if (raw === null) return RECENT_LIMIT_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return RECENT_LIMIT_DEFAULT;
  return Math.min(parsed, RECENT_LIMIT_MAX);
}

export function writeRecentLimit(value: number): void {
  if (typeof window === "undefined") return;
  const clamped = Math.max(0, Math.min(Math.trunc(value), RECENT_LIMIT_MAX));
  window.localStorage.setItem(RECENT_LIMIT_KEY, String(clamped));
  window.dispatchEvent(new CustomEvent(PREF_EVENT));
}

export function useRecentLimit(): [number, (v: number) => void] {
  const [value, setValue] = useState<number>(RECENT_LIMIT_DEFAULT);

  useEffect(() => {
    setValue(readRecentLimit());
    const onChange = () => setValue(readRecentLimit());
    window.addEventListener("storage", onChange);
    window.addEventListener(PREF_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener(PREF_EVENT, onChange);
    };
  }, []);

  return [
    value,
    (next: number) => {
      writeRecentLimit(next);
      setValue(readRecentLimit());
    },
  ];
}

/**
 * Whether the Recent section is shown at all. Independent from the
 * numeric limit so flipping it off (and back on) preserves the user's
 * preferred count.
 */
export function readRecentEnabled(): boolean {
  if (typeof window === "undefined") return RECENT_ENABLED_DEFAULT;
  const raw = window.localStorage.getItem(RECENT_ENABLED_KEY);
  if (raw === null) return RECENT_ENABLED_DEFAULT;
  return raw === "1" || raw === "true";
}

export function writeRecentEnabled(value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(RECENT_ENABLED_KEY, value ? "1" : "0");
  window.dispatchEvent(new CustomEvent(PREF_EVENT));
}

export function useRecentEnabled(): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(RECENT_ENABLED_DEFAULT);

  useEffect(() => {
    setValue(readRecentEnabled());
    const onChange = () => setValue(readRecentEnabled());
    window.addEventListener("storage", onChange);
    window.addEventListener(PREF_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener(PREF_EVENT, onChange);
    };
  }, []);

  return [
    value,
    (next: boolean) => {
      writeRecentEnabled(next);
      setValue(next);
    },
  ];
}
