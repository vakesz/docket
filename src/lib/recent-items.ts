"use client";

/**
 * Per-project recently-viewed item numbers, kept in localStorage. Stored
 * as an MRU list keyed by projectSlug so each project surfaces its own
 * recent trail without bleeding across switches. The list holds the
 * URL-facing `itemNumber` (the same string the route segment carries)
 * since that's what `/items/[itemNumber]` navigation uses.
 *
 * The display limit is a browser-local preference (`useRecentLimit` in
 * `lib/ui-prefs.ts`). `0` disables the Recent section entirely. The store
 * itself caps at `RECENT_LIMIT_MAX` so shrinking the limit later doesn't
 * lose ids the user might want back when they raise it.
 */

import { RECENT_LIMIT_MAX, readRecentEnabled, readRecentLimit, useLocalPref } from "@/lib/ui-prefs";

const STORAGE_KEY = "docket.recentItems";
const RECENT_EVENT = "docket:recent-items";

type Store = Record<string, string[]>;

function readStore(): Store {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        out[k] = v.filter((x): x is string => typeof x === "string").slice(0, RECENT_LIMIT_MAX);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    window.dispatchEvent(new CustomEvent(RECENT_EVENT));
  } catch {
    // localStorage may be disabled (private mode, quota); silently degrade.
  }
}

export function recordRecentItem(projectSlug: string, itemNumber: string): void {
  if (!projectSlug || !itemNumber) return;
  if (!readRecentEnabled()) return;
  if (readRecentLimit() === 0) return;
  const store = readStore();
  const prev = store[projectSlug] ?? [];
  store[projectSlug] = [itemNumber, ...prev.filter((x) => x !== itemNumber)].slice(
    0,
    RECENT_LIMIT_MAX,
  );
  writeStore(store);
}

const RECENT_EVENTS: readonly string[] = [RECENT_EVENT];

export function useRecentItemNumbers(projectSlug: string): string[] {
  return useLocalPref<string[]>(
    () => {
      if (!readRecentEnabled()) return [];
      const limit = readRecentLimit();
      if (limit === 0) return [];
      return (readStore()[projectSlug] ?? []).slice(0, limit);
    },
    [],
    RECENT_EVENTS,
    projectSlug,
  );
}
