"use client";

/**
 * Periodic incremental sync while a project layout is mounted.
 *
 * The interval comes from the user's `ui.auto-refresh-seconds` setting
 * (resolved in `useAutoRefreshIntervalMs`). On every tick we fire
 * `items.runSync` in incremental mode and invalidate the cursor query so
 * the footer's 'synced X ago' tracks reality. Skips:
 *   - setting is 0 (`intervalMs === false`)
 *   - read-only mode (the mutation would 403 anyway)
 *   - the tab is hidden (don't burn the user's quota in background tabs)
 *   - a previous tick is still in flight (don't pile up)
 *
 * Also fires a catch-up sync immediately when:
 *   - the hook mounts and the cached cursor is older than one interval
 *   - the tab regains focus and the cached cursor is older than one
 *     interval (covers "left it open overnight" without waiting up to one
 *     full interval before refreshing)
 *
 * The returned value is `void` — the hook is mount-and-forget. UI state
 * (footer timestamp, list panels) is driven by react-query invalidations
 * and the existing `refetchInterval` on those panels.
 */

import { useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc-client";
import { useAutoRefreshIntervalMs } from "@/lib/use-auto-refresh";

export function useBackgroundSync(projectSlug: string | null, readOnly: boolean): void {
  const intervalMs = useAutoRefreshIntervalMs();
  const utils = trpc.useUtils();
  const sync = trpc.items.runSync.useMutation({
    onSuccess: async () => {
      if (!projectSlug) return;
      await Promise.all([
        utils.items.list.invalidate(),
        utils.items.syncStatus.invalidate({ projectSlug }),
      ]);
    },
  });

  // Stash the mutation handle in a ref so the timer reads the *latest*
  // `isPending` flag without tearing down on every render. Adding
  // `sync.isPending` to the effect deps would re-create the interval each
  // time a sync starts or finishes, which defeats the periodic schedule.
  const syncRef = useRef(sync);
  syncRef.current = sync;

  useEffect(() => {
    if (!projectSlug || intervalMs === false || readOnly) return;

    const isStale = (): boolean => {
      const cached = utils.items.syncStatus.getData({ projectSlug });
      const ts = cached?.lastSyncAt ? new Date(cached.lastSyncAt).getTime() : 0;
      return !ts || Date.now() - ts > intervalMs;
    };
    const fire = () => {
      if (document.visibilityState === "hidden") return;
      const m = syncRef.current;
      if (m.isPending) return;
      m.mutate({ projectSlug, mode: "incremental" });
    };

    // Catch-up on mount: if the cached cursor is older than one interval,
    // sync now instead of waiting for the first scheduled tick.
    if (isStale()) fire();

    const id = setInterval(fire, intervalMs);

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (isStale()) fire();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [projectSlug, intervalMs, readOnly, utils.items.syncStatus.getData]);
}
