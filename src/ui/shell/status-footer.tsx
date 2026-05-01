"use client";

import { useEffect, useMemo, useState } from "react";
import { formatRelative } from "@/lib/format";
import { trpc } from "@/lib/trpc-client";
import { useAutoRefreshIntervalMs } from "@/lib/use-auto-refresh";
import { useBackgroundSync } from "@/lib/use-background-sync";
import { cn } from "@/lib/utils";
import { ProposalDialog } from "@/ui/proposals/proposal-dialog";
import { PaletteHint } from "@/ui/shell/palette-hint";
import { SyncButton } from "@/ui/shell/sync-button";

/**
 * Compact status bar pinned to the bottom of the workspace. Carries
 * runtime-only signals — connectivity, last sync, pending proposals,
 * read-only mode — and stays out of project-identity duty (the topbar
 * switcher owns that, and individual settings sections show their own
 * project chip).
 *
 * Sync stays here as a labeled control alongside `synced X ago` for
 * discoverability, while the topbar mounts a glyph-only twin so refresh
 * is reachable from anywhere without scanning the footer.
 *
 * The footer also hosts `useBackgroundSync` — same lifetime as the layout
 * chrome, both layouts mount one footer, no separate wrapper needed.
 */
export function StatusFooter({
  projectSlug,
  pendingProposals = 0,
  readOnly = false,
}: {
  projectSlug: string | null;
  pendingProposals?: number;
  readOnly?: boolean;
}) {
  const [online, setOnline] = useState(true);
  const [, setTick] = useState(0);

  const refetchInterval = useAutoRefreshIntervalMs();
  const syncStatus = trpc.items.syncStatus.useQuery(
    { projectSlug: projectSlug ?? "" },
    {
      enabled: !!projectSlug,
      // While a sync is running, poll fast so the footer text actually
      // reflects what's happening; otherwise fall back to the user's
      // auto-refresh cadence (or off).
      refetchInterval: (query) =>
        query.state.data?.progress?.status === "running"
          ? 1_500
          : refetchInterval === false
            ? false
            : refetchInterval,
      staleTime: 0,
    },
  );
  const lastSyncAt = syncStatus.data?.lastSyncAt ?? null;
  const syncProgress = syncStatus.data?.progress ?? null;
  const syncing = syncProgress?.status === "running";

  useBackgroundSync(projectSlug, readOnly);

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
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-border border-t bg-card px-3 py-1.5 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span
          className={cn("h-1.5 w-1.5 rounded-full", online ? "bg-primary" : "bg-destructive")}
          aria-hidden="true"
        />
        <span className="uppercase tracking-wide">{online ? "online" : "offline"}</span>
      </span>
      {projectSlug ? (
        <>
          <span className="text-muted-foreground/70">·</span>
          <span className="inline-flex items-center gap-1">
            <span>
              {syncing && syncProgress
                ? `syncing · ${syncProgress.phaseLabel.toLowerCase()} · ${syncProgress.itemsSeen} seen · ${syncProgress.upserted} upserted${syncProgress.mode === "full" ? ` · ${syncProgress.archived} archived` : ""}`
                : lastSyncAt
                  ? `synced ${formatRelative(lastSyncAt)}`
                  : "never synced"}
            </span>
            <SyncButton projectSlug={projectSlug} readOnly={readOnly} variant="footer" />
          </span>
        </>
      ) : null}
      {projectSlug ? (
        <PendingProposalsButton projectSlug={projectSlug} initialCount={pendingProposals} />
      ) : null}
      {readOnly ? (
        <>
          <span className="text-muted-foreground/70">·</span>
          <span className="rounded-full border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 font-semibold text-[10px] text-destructive uppercase tracking-wide">
            Read-only
          </span>
        </>
      ) : null}
      <PaletteHint className="ml-auto" />
    </footer>
  );
}

/**
 * "{N} pending" footer button. Click → open the confirm dialog for the
 * oldest pending proposal in place. The dialog is self-contained (it
 * loads everything via `proposals.get`), so we deliberately do NOT
 * navigate to the underlying ticket — `providerItemId` is GitHub-shaped
 * (`owner/repo#123`) and would break the `/items/[itemId]` route, and
 * memory + item-create proposals have no item to navigate to at all.
 *
 * The query is `staleTime: 0` because count drift after a confirm/reject
 * matters more here than refetch chatter — the moment the dialog closes,
 * we want the fresh count.
 */
function PendingProposalsButton({
  projectSlug,
  initialCount,
}: {
  projectSlug: string;
  initialCount: number;
}) {
  const utils = trpc.useUtils();
  const [activeProposalId, setActiveProposalId] = useState<string | null>(null);

  const list = trpc.proposals.list.useQuery(
    { projectSlug, status: "pending", limit: 100 },
    { staleTime: 0 },
  );

  const proposals = list.data ?? [];
  const count = list.data ? proposals.length : initialCount;

  // Oldest-first drains the queue in the order the agent staged them,
  // matching the user's mental model of "the one I forgot about first."
  const oldestPendingId = useMemo(() => {
    if (proposals.length === 0) return null;
    const next = [...proposals].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )[0];
    return next?.id ?? null;
  }, [proposals]);

  if (count === 0) return null;

  const openNext = () => {
    if (!oldestPendingId) return;
    setActiveProposalId(oldestPendingId);
  };

  return (
    <>
      <span className="text-muted-foreground/70">·</span>
      <button
        type="button"
        onClick={openNext}
        aria-haspopup="dialog"
        aria-label={`Review next of ${count} pending proposal${count === 1 ? "" : "s"}`}
        className={cn(
          "cursor-pointer rounded px-1 text-primary hover:bg-muted",
          "focus:outline-none focus:ring-1 focus:ring-ring",
        )}
      >
        {count} pending
      </button>
      <ProposalDialog
        projectSlug={projectSlug}
        proposalId={activeProposalId}
        onClose={() => {
          setActiveProposalId(null);
          // Force a fresh count: the dialog only invalidates on confirm,
          // not on backdrop-dismiss, so a manual invalidate here keeps the
          // footer count honest if the user closed without acting.
          utils.proposals.list.invalidate({ projectSlug });
        }}
      />
    </>
  );
}
