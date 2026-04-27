"use client";

/**
 * Per-project recently-viewed item ids, kept in localStorage. Stored as
 * an MRU list keyed by projectId so each project surfaces its own recent
 * trail without bleeding across switches. The list holds canonical item
 * ids (not provider ids) since that's what /items/[id] navigation uses.
 */

import { useEffect, useState } from "react";

const STORAGE_KEY = "docket.recentItems";
const RECENT_LIMIT = 5;
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
        out[k] = v.filter((x): x is string => typeof x === "string").slice(0, RECENT_LIMIT);
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
  const store = readStore();
  const prev = store[projectId] ?? [];
  store[projectId] = [itemId, ...prev.filter((x) => x !== itemId)].slice(0, RECENT_LIMIT);
  writeStore(store);
}

export function useRecentItemIds(projectId: string): string[] {
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    const sync = () => setIds(readStore()[projectId] ?? []);
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener(RECENT_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(RECENT_EVENT, sync);
    };
  }, [projectId]);

  return ids;
}
