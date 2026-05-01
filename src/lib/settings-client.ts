"use client";

/**
 * Browser-side accessor for the global Setting table.
 *
 * The settings router returns a flat array, but most consumers want random
 * access by key plus typed coercion. This hook keys the rows once per data
 * refresh and exposes small value-typed accessors so callers don't repeat the
 * `find + typeof` dance at every read site.
 */

import { useMemo } from "react";
import { trpc } from "@/lib/trpc-client";

type SettingsView = {
  list: ReturnType<typeof trpc.settings.list.useQuery>;
  raw: (key: string) => unknown;
  num: (key: string, fallback: number) => number;
  bool: (key: string, fallback: boolean) => boolean;
  str: (key: string, fallback: string) => string;
};

export function useSettingsMap(opts?: { staleTime?: number }): SettingsView {
  const list = trpc.settings.list.useQuery(undefined, opts);
  const map = useMemo(() => {
    const m = new Map<string, unknown>();
    for (const row of list.data ?? []) m.set(row.key, row.value);
    return m;
  }, [list.data]);

  return {
    list,
    raw: (key) => map.get(key),
    num: (key, fallback) => {
      const v = map.get(key);
      return typeof v === "number" ? v : fallback;
    },
    bool: (key, fallback) => {
      const v = map.get(key);
      return typeof v === "boolean" ? v : fallback;
    },
    str: (key, fallback) => {
      const v = map.get(key);
      return typeof v === "string" ? v : fallback;
    },
  };
}
