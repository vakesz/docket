"use client";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

export function SyncButton({
  projectId,
  mode = "incremental",
}: {
  projectId: string;
  mode?: "incremental" | "full";
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const sync = trpc.items.runSync.useMutation({
    onSuccess: async () => {
      await utils.items.list.invalidate();
      router.refresh();
    },
  });
  const label = mode === "full" ? "Full sync" : "Refresh";
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={sync.isPending}
        onClick={() => sync.mutate({ projectId, mode })}
        className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        {sync.isPending ? `${label}…` : label}
      </button>
      {sync.error ? (
        <span className="text-xs text-red-700 dark:text-red-300">{sync.error.message}</span>
      ) : sync.data ? (
        <span className="text-xs text-zinc-500">
          +{sync.data.upserted} upserted, {sync.data.archived} archived
        </span>
      ) : null}
    </div>
  );
}
