"use client";

import { useRouter } from "next/navigation";
import { formatRelative } from "@/lib/format";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";

function formatTimestamp(value: Date | string | null): string {
  if (!value) return "never";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "never";
  return d.toLocaleString();
}

/**
 * Settings → Project → Sync. Surfaces the project's sync cursor and lets
 * the user kick off either an incremental refresh or a full walk. Full
 * sync is the only way to archive items the provider no longer returns,
 * so it lives here next to the cursor it resets.
 */
export function SyncPanel({ projectSlug }: { projectSlug: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const status = trpc.items.syncStatus.useQuery(
    { projectSlug },
    {
      staleTime: 0,
      refetchInterval: (query) =>
        query.state.data?.progress?.status === "running" ? 1_500 : false,
    },
  );
  const sync = trpc.items.runSync.useMutation({
    onMutate: async () => {
      await utils.items.syncStatus.invalidate({ projectSlug });
    },
    onSuccess: async () => {
      await Promise.all([
        utils.items.list.invalidate(),
        utils.items.syncStatus.invalidate({ projectSlug }),
      ]);
      router.refresh();
    },
  });

  const watermark = status.data?.watermark ?? null;
  const lastFullSyncAt = status.data?.lastFullSyncAt ?? null;
  const progress = status.data?.progress ?? null;
  const running = progress?.status === "running";
  const pending = sync.isPending || running;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Watermark</span>
            <span className="font-mono text-sm text-foreground">{formatTimestamp(watermark)}</span>
            <p className="text-xs text-muted-foreground">
              Incremental sync pulls items updated after this point.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Last full sync
            </span>
            <span className="font-mono text-sm text-foreground">
              {formatTimestamp(lastFullSyncAt)}
            </span>
            <p className="text-xs text-muted-foreground">
              A full walk reconciles archived items the provider no longer returns.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          {running && progress ? (
            <div className="w-full rounded-lg border border-border bg-muted/40 p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground">
                  {progress.mode === "full" ? "Full" : "Incremental"} sync running
                </span>
                <span className="text-muted-foreground">{progress.phaseLabel}</span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground sm:grid-cols-4">
                <span>Chunks</span>
                <span className="text-right text-foreground sm:text-left">
                  {progress.chunksCompleted}
                </span>
                <span>Items seen</span>
                <span className="text-right text-foreground sm:text-left">
                  {progress.itemsSeen}
                </span>
                <span>Upserted</span>
                <span className="text-right text-foreground sm:text-left">{progress.upserted}</span>
                {progress.mode === "full" ? (
                  <>
                    <span>Archived</span>
                    <span className="text-right text-foreground sm:text-left">
                      {progress.archived}
                    </span>
                  </>
                ) : null}
              </div>
              <p className="mt-2 text-muted-foreground">
                Updated {formatRelative(progress.updatedAt)}
              </p>
            </div>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => sync.mutate({ projectSlug, mode: "incremental" })}
          >
            {pending && sync.variables?.mode !== "full" ? "Refreshing…" : "Refresh"}
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={() => {
              if (
                window.confirm(
                  "Run a full sync? Walks every item the provider returns and archives any cached row no longer visible. Slower than Refresh.",
                )
              ) {
                sync.mutate({ projectSlug, mode: "full" });
              }
            }}
          >
            {pending && sync.variables?.mode === "full" ? "Running full sync…" : "Run full sync"}
          </Button>
          {progress?.status === "failed" && progress.error ? (
            <span className="text-xs text-destructive">{progress.error}</span>
          ) : sync.error ? (
            <span className="text-xs text-destructive">{sync.error.message}</span>
          ) : sync.data ? (
            <span className="text-xs text-muted-foreground">
              {sync.data.upserted} upserted · {sync.data.archived} archived
              {sync.data.inboundConversations > 0
                ? ` · ${sync.data.inboundConversations} conversation${
                    sync.data.inboundConversations === 1 ? "" : "s"
                  } notified`
                : ""}
            </span>
          ) : null}
        </div>
      </section>
    </div>
  );
}
