"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatRelative } from "@/lib/format";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";

/**
 * Compact status bar pinned to the bottom of the workspace. Shows browser
 * connectivity, the active project, last sync, pending proposals, and
 * read-only mode. The caller (project layout) hands in the server-side
 * values; only `online` and the relative-time tick are client state.
 *
 * Sync lives here (not in the topbar or detail header) so it stays one
 * click away from anywhere in the workspace without competing with the
 * per-item actions for header real estate.
 */
export function StatusFooter({
  projectId,
  projectName,
  providerKind,
  lastSyncAt = null,
  pendingProposals = 0,
  readOnly = false,
}: {
  projectId: string | null;
  projectName: string | null;
  providerKind: string | null;
  lastSyncAt?: Date | string | null;
  pendingProposals?: number;
  readOnly?: boolean;
}) {
  const [online, setOnline] = useState(true);
  const [, setTick] = useState(0);
  const router = useRouter();
  const utils = trpc.useUtils();
  const sync = trpc.items.runSync.useMutation({
    onSuccess: async () => {
      await utils.items.list.invalidate();
      router.refresh();
    },
  });
  const canSync = Boolean(projectId) && !readOnly;
  const syncDisabled = !canSync || sync.isPending;

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    const tick = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      clearInterval(tick);
    };
  }, []);

  return (
    <footer className="flex items-center gap-3 border-t border-border bg-surface px-3 py-1.5 text-[11px] text-fg-muted">
      <span className="flex items-center gap-1.5">
        <span
          className={cn("h-1.5 w-1.5 rounded-full", online ? "bg-success" : "bg-danger")}
          aria-hidden="true"
        />
        <span className="uppercase tracking-wide">{online ? "online" : "offline"}</span>
      </span>
      {projectName ? (
        <>
          <span className="text-fg-faint">·</span>
          <span className="truncate font-medium text-fg">{projectName}</span>
          {providerKind ? (
            <span className="rounded-full border border-border bg-surface-alt px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
              {providerKind.replace("_", " ")}
            </span>
          ) : null}
        </>
      ) : null}
      {projectId ? (
        <>
          <span className="text-fg-faint">·</span>
          <span className="inline-flex items-center gap-1">
            <span>{lastSyncAt ? `synced ${formatRelative(lastSyncAt)}` : "never synced"}</span>
            <button
              type="button"
              onClick={() => {
                if (!projectId || sync.isPending) return;
                sync.mutate({ projectId, mode: "incremental" });
              }}
              disabled={syncDisabled}
              aria-label="Sync now"
              title={
                readOnly
                  ? "Read-only mode — sync disabled"
                  : sync.isPending
                    ? "Syncing…"
                    : "Sync now"
              }
              className={cn(
                "inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded border border-transparent text-fg-muted transition-colors",
                "hover:border-border hover:bg-surface-alt hover:text-fg",
                "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-fg-muted",
                "focus:outline-none focus:ring-1 focus:ring-accent",
              )}
            >
              <RefreshCw
                aria-hidden="true"
                className={cn("h-3 w-3", sync.isPending && "animate-spin")}
              />
            </button>
            {sync.error ? (
              <span className="text-danger-fg" title={sync.error.message}>
                · sync failed
              </span>
            ) : null}
          </span>
        </>
      ) : null}
      {pendingProposals > 0 ? (
        <>
          <span className="text-fg-faint">·</span>
          <span className="text-warning">{pendingProposals} pending</span>
        </>
      ) : null}
      {readOnly ? (
        <>
          <span className="text-fg-faint">·</span>
          <span className="rounded-full border border-danger/40 bg-danger-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger-fg">
            Read-only
          </span>
        </>
      ) : null}
    </footer>
  );
}
