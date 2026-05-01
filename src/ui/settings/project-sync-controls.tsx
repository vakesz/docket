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
 * Inline per-project sync controls rendered on each row in the Projects
 * panel. Surfaces the cursor + last-full-sync timestamp and lets the user
 * kick off either an incremental refresh or a full walk. Full sync is the
 * only way to archive items the provider no longer returns, so it stays
 * paired with the cursor it resets.
 */
export function ProjectSyncControls({ projectSlug }: { projectSlug: string }) {
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
    <div className="flex flex-col gap-2 border-border border-t pt-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
        <span className="text-muted-foreground">
          Watermark <span className="font-mono text-foreground">{formatTimestamp(watermark)}</span>
        </span>
        <span className="text-muted-foreground">
          Last full sync{" "}
          <span className="font-mono text-foreground">{formatTimestamp(lastFullSyncAt)}</span>
        </span>
      </div>

      {running && progress ? (
        <div className="rounded-lg border border-border bg-muted/40 p-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-foreground">
              {progress.mode === "full" ? "Full" : "Incremental"} sync running
            </span>
            <span className="text-muted-foreground">{progress.phaseLabel}</span>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground sm:grid-cols-4">
            <span>Chunks</span>
            <span className="text-right text-foreground sm:text-left">
              {progress.chunksCompleted}
            </span>
            <span>Items seen</span>
            <span className="text-right text-foreground sm:text-left">{progress.itemsSeen}</span>
            <span>Upserted</span>
            <span className="text-right text-foreground sm:text-left">{progress.upserted}</span>
            {progress.mode === "full" ? (
              <>
                <span>Archived</span>
                <span className="text-right text-foreground sm:text-left">{progress.archived}</span>
              </>
            ) : null}
          </div>
          <p className="mt-1 text-muted-foreground">Updated {formatRelative(progress.updatedAt)}</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={pending}
          onClick={() => sync.mutate({ projectSlug, mode: "incremental" })}
        >
          {pending && sync.variables?.mode !== "full" ? "Refreshing…" : "Refresh"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
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
          {pending && sync.variables?.mode === "full" ? "Running full sync…" : "Full sync"}
        </Button>
        {progress?.status === "failed" && progress.error ? (
          <span className="text-destructive text-xs">{progress.error}</span>
        ) : sync.error ? (
          <span className="text-destructive text-xs">{sync.error.message}</span>
        ) : sync.data ? (
          <span className="text-muted-foreground text-xs">
            {sync.data.upserted} upserted · {sync.data.archived} archived
            {sync.data.inboundConversations > 0
              ? ` · ${sync.data.inboundConversations} conversation${
                  sync.data.inboundConversations === 1 ? "" : "s"
                } notified`
              : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}
