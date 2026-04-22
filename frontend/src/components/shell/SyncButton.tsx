import { useManualSync } from "~/api/hooks";
import { cn } from "~/lib/cn";

export function SyncButton() {
  const sync = useManualSync();
  return (
    <button
      type="button"
      disabled={sync.isPending}
      onClick={() => sync.mutate()}
      title={
        sync.data
          ? `Upserted ${sync.data.upserted}, archived ${sync.data.archived}`
          : "Refresh from provider"
      }
      className={cn(
        "rounded border border-border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider",
        "text-fg-muted hover:bg-surface-alt",
        sync.isPending && "animate-pulse",
      )}
    >
      {sync.isPending ? "Syncing…" : "Sync"}
    </button>
  );
}
