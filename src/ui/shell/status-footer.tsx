"use client";

import { useEffect, useState } from "react";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Compact status bar pinned to the bottom of the workspace. Shows browser
 * connectivity, the active project, last sync, pending proposals, and
 * read-only mode. The caller (project layout) hands in the server-side
 * values; only `online` and the relative-time tick are client state.
 */
export function StatusFooter({
  projectName,
  providerKind,
  lastSyncAt = null,
  pendingProposals = 0,
  readOnly = false,
}: {
  projectName: string | null;
  providerKind: string | null;
  lastSyncAt?: Date | string | null;
  pendingProposals?: number;
  readOnly?: boolean;
}) {
  const [online, setOnline] = useState(true);
  const [, setTick] = useState(0);

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
      {lastSyncAt ? (
        <>
          <span className="text-fg-faint">·</span>
          <span>synced {formatRelative(lastSyncAt)}</span>
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
