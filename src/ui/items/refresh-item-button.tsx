"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";

/**
 * Header button that re-syncs the open item from its provider — fresh body,
 * fields, and comments. Replaces the older "Refresh comments" affordance: at
 * the detail-pane scope you almost always want everything fresh, not just
 * the comment list.
 */
export function RefreshItemButton({ projectId, itemId }: { projectId: string; itemId: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const refresh = trpc.items.refreshItem.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.items.list.invalidate({ projectId }),
        utils.items.get.invalidate({ projectId, itemId }),
      ]);
      router.refresh();
    },
  });
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={refresh.isPending}
      onClick={() => refresh.mutate({ projectId, itemId })}
      title={refresh.isPending ? "Refreshing…" : "Refresh from provider"}
      aria-label="Refresh item"
    >
      <RefreshCw aria-hidden="true" className={refresh.isPending ? "animate-spin" : undefined} />
      Refresh
    </Button>
  );
}
