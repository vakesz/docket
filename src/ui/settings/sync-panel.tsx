"use client";

import { useRouter } from "next/navigation";
import {
  metaLabelClass,
  primaryButtonClass,
  secondaryButtonClass,
  settingsPanelClass,
} from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";

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
export function SyncPanel({ projectId }: { projectId: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const status = trpc.items.syncStatus.useQuery({ projectId });
  const sync = trpc.items.runSync.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.items.list.invalidate(),
        utils.items.syncStatus.invalidate({ projectId }),
      ]);
      router.refresh();
    },
  });

  const watermark = status.data?.watermark ?? null;
  const lastFullSyncAt = status.data?.lastFullSyncAt ?? null;
  const pending = sync.isPending;

  return (
    <div className="flex flex-col gap-6">
      <section className={`${settingsPanelClass} flex flex-col gap-4`}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className={metaLabelClass}>Watermark</span>
            <span className="font-mono text-sm text-foreground">{formatTimestamp(watermark)}</span>
            <p className="text-xs text-muted-foreground">
              Incremental sync pulls items updated after this point.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <span className={metaLabelClass}>Last full sync</span>
            <span className="font-mono text-sm text-foreground">
              {formatTimestamp(lastFullSyncAt)}
            </span>
            <p className="text-xs text-muted-foreground">
              A full walk reconciles archived items the provider no longer returns.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <button
            type="button"
            disabled={pending}
            onClick={() => sync.mutate({ projectId, mode: "incremental" })}
            className={secondaryButtonClass}
          >
            {pending && sync.variables?.mode !== "full" ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (
                window.confirm(
                  "Run a full sync? Walks every item the provider returns and archives any cached row no longer visible. Slower than Refresh.",
                )
              ) {
                sync.mutate({ projectId, mode: "full" });
              }
            }}
            className={primaryButtonClass}
          >
            {pending && sync.variables?.mode === "full" ? "Running full sync…" : "Run full sync"}
          </button>
          {sync.error ? (
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
