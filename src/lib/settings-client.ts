"use client";

/**
 * Browser-side accessors for the Setting table.
 *
 * The settings router returns a flat array per scope, but most consumers want
 * random access by key plus typed coercion. These hooks key the rows once per
 * data refresh and expose small value-typed accessors so callers don't repeat
 * the `find + typeof` dance at every read site.
 *
 * Three variants, one per scope: user (`list`), deployment-wide (`globalList`),
 * project (`projectList`). All three return the same `SettingsView` shape so
 * callers can switch scope without touching read sites.
 */

import { trpc } from "@/lib/trpc-client";

type AnyQuery = { data: ReadonlyArray<{ key: string; value: unknown }> | undefined } & {
  isPending: boolean;
};

type SettingsView<Q extends AnyQuery> = {
  list: Q;
  raw: (key: string) => unknown;
  num: (key: string, fallback: number) => number;
  bool: (key: string, fallback: boolean) => boolean;
  str: (key: string, fallback: string) => string;
};

function viewOf<Q extends AnyQuery>(list: Q): SettingsView<Q> {
  const map = new Map<string, unknown>();
  for (const row of list.data ?? []) map.set(row.key, row.value);
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

export function useSettingsMap(opts?: { staleTime?: number }) {
  return viewOf(trpc.settings.list.useQuery(undefined, opts));
}

export function useGlobalSettingsMap(opts?: { staleTime?: number }) {
  return viewOf(trpc.settings.globalList.useQuery(undefined, opts));
}

export function useProjectSettingsMap(
  args: { projectSlug: string | null },
  opts?: { staleTime?: number },
) {
  return viewOf(
    trpc.settings.projectList.useQuery(
      { projectSlug: args.projectSlug ?? "" },
      { ...opts, enabled: args.projectSlug !== null },
    ),
  );
}
