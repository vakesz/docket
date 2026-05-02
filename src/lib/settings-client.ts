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

import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
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

type ProjectSettingsView = ReturnType<typeof useProjectSettingsMap>;

/**
 * Per-project settings form bundle.
 *
 * Wraps the three-step pattern every project-scoped settings panel
 * repeats: load the project's settings, seed local form state once per
 * project (re-seeding on every refetch would clobber in-flight edits —
 * including the partial-state window during parallel-mutation submits),
 * and bind a save mutation that auto-invalidates the list on success.
 *
 * `seed` runs once after the first load for each `projectSlug`; switching
 * projects re-runs it against the new project's data. `initial` is the
 * value used before the load completes.
 */
export function useProjectSettingsForm<T>(args: {
  projectSlug: string;
  initial: T;
  seed: (view: ProjectSettingsView) => T;
}): {
  view: ProjectSettingsView;
  values: T;
  setValues: Dispatch<SetStateAction<T>>;
  isLoading: boolean;
  save: ReturnType<typeof trpc.settings.projectUpdate.useMutation>;
  saveMany: (entries: ReadonlyArray<{ key: string; value: unknown }>) => Promise<void>;
} {
  const utils = trpc.useUtils();
  const view = useProjectSettingsMap({ projectSlug: args.projectSlug });
  const [values, setValues] = useState<T>(args.initial);

  const seedRef = useRef(args.seed);
  seedRef.current = args.seed;
  const seededForRef = useRef<string | null>(null);
  useEffect(() => {
    if (seededForRef.current === args.projectSlug) return;
    if (!view.list.data) return;
    setValues(seedRef.current(view));
    seededForRef.current = args.projectSlug;
  }, [view, args.projectSlug]);

  const save = trpc.settings.projectUpdate.useMutation({
    onSuccess: async () => {
      await utils.settings.projectList.invalidate({ projectSlug: args.projectSlug });
    },
  });

  const saveMany = async (entries: ReadonlyArray<{ key: string; value: unknown }>) => {
    await Promise.all(
      entries.map((e) => save.mutateAsync({ projectSlug: args.projectSlug, ...e })),
    );
  };

  return {
    view,
    values,
    setValues,
    isLoading: view.list.isPending,
    save,
    saveMany,
  };
}
