"use client";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

export function RefreshCommentsButton({
  projectId,
  itemId,
}: {
  projectId: string;
  itemId: string;
}) {
  const router = useRouter();
  const refresh = trpc.items.refreshComments.useMutation({
    onSuccess: () => router.refresh(),
  });
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={refresh.isPending}
        onClick={() => refresh.mutate({ projectId, itemId })}
        className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        {refresh.isPending ? "Refreshing…" : "Refresh comments"}
      </button>
      {refresh.error ? (
        <span className="text-xs text-red-700 dark:text-red-300">{refresh.error.message}</span>
      ) : refresh.data ? (
        <span className="text-xs text-zinc-500">{refresh.data.count} comments</span>
      ) : null}
    </div>
  );
}
