"use client";
import { useRouter } from "next/navigation";
import { xsBorderButtonClass } from "@/lib/form-classes";
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
        className={xsBorderButtonClass}
      >
        {sync.isPending ? `${label}…` : label}
      </button>
      {sync.error ? (
        <span className="text-xs text-danger-fg">{sync.error.message}</span>
      ) : sync.data ? (
        <span className="text-xs text-fg-faint">
          +{sync.data.upserted} upserted, {sync.data.archived} archived
        </span>
      ) : null}
    </div>
  );
}
