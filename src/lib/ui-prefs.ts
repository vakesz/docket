"use client";

/**
 * Browser-local UI preferences.
 *
 * These deliberately bypass the Setting table — they're cosmetic,
 * device-specific, and shouldn't sync across machines. Tiny read/write
 * functions plus a hook that subscribes to a custom event so multiple
 * mounts stay in sync without prop drilling.
 *
 * Keep this list small. If a preference grows server-side semantics
 * (gates a feature, drives audit, etc.) promote it into the catalog.
 */

import { useEffect, useRef, useState } from "react";

export type ToolDisplayMode = "show" | "collapse" | "hide";

const TOOL_DISPLAY_KEY = "docket.chat.toolDisplay";
const VALID_MODES: ReadonlySet<string> = new Set(["show", "collapse", "hide"]);
export const PREF_EVENT = "docket:uiprefs";

const RECENT_LIMIT_KEY = "docket.items.recentLimit";
const RECENT_LIMIT_DEFAULT = 5;
export const RECENT_LIMIT_MAX = 20;

const RECENT_ENABLED_KEY = "docket.items.recentEnabled";
const RECENT_ENABLED_DEFAULT = true;

/**
 * Union of every localStorage key the pref/recent-items subsystem owns.
 * Subscribers pass the keys they actually depend on so a write to one
 * pref only wakes the components that read it (the alternative is every
 * `useLocalPref` mount re-running its selector on every keystroke that
 * touches any pref). Add new keys here when promoting a write through
 * `emitPrefChange`.
 */
export type PrefKey =
  | typeof TOOL_DISPLAY_KEY
  | typeof RECENT_LIMIT_KEY
  | typeof RECENT_ENABLED_KEY
  | "docket.recentItems";

/**
 * Notify same-tab subscribers that a pref/local-store key changed.
 * Cross-tab `storage` events fire automatically when localStorage is
 * written; this dispatch covers the originating tab (which `storage`
 * intentionally skips) and components that share a key in the same tab.
 */
export function emitPrefChange(key: PrefKey): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PrefKey>(PREF_EVENT, { detail: key }));
}

/**
 * Subscribe a value derived from localStorage to the standard pref-change
 * channels: cross-tab `storage` events plus our same-tab `PREF_EVENT`.
 * `watch` lists the keys this selector actually depends on; the listener
 * filters by detail/key so unrelated pref writes don't wake every mount.
 *
 * `read` is allowed to change between renders — the latest version is held in
 * a ref so the listener always reads via the current closure. Pass a `rebindKey`
 * (e.g. the projectSlug a per-project read depends on) to force the value to
 * refresh when the closure's logical input changes; the listeners themselves
 * stay bound. SSR sees `initial`, hydration sees the read.
 */
export function useLocalPref<T>(
  read: () => T,
  initial: T,
  watch: readonly PrefKey[],
  rebindKey?: string,
): T {
  const readRef = useRef(read);
  readRef.current = read;
  const [value, setValue] = useState<T>(initial);

  // Callers pass a module-scoped `watch` array (TOOL_DISPLAY_WATCH,
  // RECENT_WATCH, etc.) so the reference itself is stable. The set
  // captured by the effect closure is recreated only when `watch`
  // changes identity.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebindKey + watch identity drive resubscription; `read` is held in a ref to avoid recapture on every render.
  useEffect(() => {
    setValue(readRef.current());
    const watched = new Set<string>(watch);
    const onPref = (ev: Event) => {
      const detail = (ev as CustomEvent<PrefKey>).detail;
      if (!detail || watched.has(detail)) setValue(readRef.current());
    };
    const onStorage = (ev: StorageEvent) => {
      if (ev.key === null || watched.has(ev.key)) setValue(readRef.current());
    };
    window.addEventListener(PREF_EVENT, onPref);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PREF_EVENT, onPref);
      window.removeEventListener("storage", onStorage);
    };
  }, [rebindKey, watch]);

  return value;
}

const TOOL_DISPLAY_WATCH: readonly PrefKey[] = [TOOL_DISPLAY_KEY];
const RECENT_LIMIT_WATCH: readonly PrefKey[] = [RECENT_LIMIT_KEY];
const RECENT_ENABLED_WATCH: readonly PrefKey[] = [RECENT_ENABLED_KEY];

export function readToolDisplayMode(): ToolDisplayMode {
  if (typeof window === "undefined") return "collapse";
  const raw = window.localStorage.getItem(TOOL_DISPLAY_KEY);
  return raw && VALID_MODES.has(raw) ? (raw as ToolDisplayMode) : "collapse";
}

export function writeToolDisplayMode(value: ToolDisplayMode): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOOL_DISPLAY_KEY, value);
  emitPrefChange(TOOL_DISPLAY_KEY);
}

export function useToolDisplayMode(): [ToolDisplayMode, (v: ToolDisplayMode) => void] {
  const value = useLocalPref<ToolDisplayMode>(readToolDisplayMode, "collapse", TOOL_DISPLAY_WATCH);
  return [
    value,
    (next: ToolDisplayMode) => {
      writeToolDisplayMode(next);
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
  emitPrefChange(RECENT_LIMIT_KEY);
}

export function useRecentLimit(): [number, (v: number) => void] {
  const value = useLocalPref<number>(readRecentLimit, RECENT_LIMIT_DEFAULT, RECENT_LIMIT_WATCH);
  return [
    value,
    (next: number) => {
      writeRecentLimit(next);
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
  emitPrefChange(RECENT_ENABLED_KEY);
}

export function useRecentEnabled(): [boolean, (v: boolean) => void] {
  const value = useLocalPref<boolean>(
    readRecentEnabled,
    RECENT_ENABLED_DEFAULT,
    RECENT_ENABLED_WATCH,
  );
  return [
    value,
    (next: boolean) => {
      writeRecentEnabled(next);
    },
  ];
}
