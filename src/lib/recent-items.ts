"use client";

/**
 * Per-project recently-viewed item ids, kept in localStorage. Stored as
 * an MRU list keyed by projectId so each project surfaces its own recent
 * trail without bleeding across switches. The list holds canonical item
 * ids (not provider ids) since that's what /items/[id] navigation uses.
 *
 * The display limit is a browser-local preference (`useRecentLimit` in
 * `lib/ui-prefs.ts`). `0` disables the Recent section entirely. The store
 * itself caps at `RECENT_LIMIT_MAX` so shrinking the limit later doesn't
 * lose ids the user might want back when they raise it.
 */

import { useEffect, useState } from "react";
import { RECENT_LIMIT_MAX, readRecentLimit } from "@/lib/ui-prefs";

const STORAGE_KEY = "docket.recentItems";
const RECENT_EVENT = "docket:recent-items";
const PREF_EVENT = "docket:uiprefs";

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

export function recordRecentItem(projectId: string, itemId: string): void {
  if (!projectId || !itemId) return;
  if (readRecentLimit() === 0) return;
  const store = readStore();
  const prev = store[projectId] ?? [];
  store[projectId] = [itemId, ...prev.filter((x) => x !== itemId)].slice(0, RECENT_LIMIT_MAX);
  writeStore(store);
}

export function useRecentItemIds(projectId: string): string[] {
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    const sync = () => {
      const limit = readRecentLimit();
      if (limit === 0) {
        setIds([]);
        return;
      }
      setIds((readStore()[projectId] ?? []).slice(0, limit));
    };
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener(RECENT_EVENT, sync);
    window.addEventListener(PREF_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(RECENT_EVENT, sync);
      window.removeEventListener(PREF_EVENT, sync);
    };
  }, [projectId]);

  return ids;
}
