"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/primitives/button";

/**
 * Header button that re-syncs the open item from its provider — fresh body,
 * fields, and comments. `compact` renders as a borderless icon-only button
 * for the detail header's utility cluster.
 */
export function RefreshItemButton({
  projectId,
  itemId,
  compact = false,
}: {
  projectId: string;
  itemId: string;
  compact?: boolean;
}) {
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

  const title = refresh.isPending ? "Refreshing…" : "Refresh from provider";
  const onClick = () => refresh.mutate({ projectId, itemId });

  if (compact) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={refresh.isPending}
        onClick={onClick}
        title={title}
        aria-label="Refresh item"
      >
        <RefreshCw aria-hidden="true" className={cn(refresh.isPending && "animate-spin")} />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={refresh.isPending}
      onClick={onClick}
      title={title}
      aria-label="Refresh item"
    >
      <RefreshCw aria-hidden="true" className={cn(refresh.isPending && "animate-spin")} />
      Refresh
    </Button>
  );
}
