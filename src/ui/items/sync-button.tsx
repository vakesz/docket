"use client";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";

export function SyncButton({
  projectSlug,
  mode = "incremental",
}: {
  projectSlug: string;
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
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={sync.isPending}
        onClick={() => sync.mutate({ projectSlug, mode })}
      >
        {sync.isPending ? `${label}…` : label}
      </Button>
      {sync.error ? (
        <span className="text-xs text-destructive">{sync.error.message}</span>
      ) : sync.data ? (
        <span className="text-xs text-muted-foreground-faint">
          +{sync.data.upserted} upserted, {sync.data.archived} archived
        </span>
      ) : null}
    </div>
  );
}
