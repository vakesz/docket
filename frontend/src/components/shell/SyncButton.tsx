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
        "rounded border border-zinc-200 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider",
        "text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900",
        sync.isPending && "animate-pulse",
      )}
    >
      {sync.isPending ? "Syncing…" : "Sync"}
    </button>
  );
}
