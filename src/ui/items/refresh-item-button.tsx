"use client";

import { Button } from "@headlessui/react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { xsBorderButtonClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";

const ghostClass =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-alt hover:text-fg disabled:cursor-not-allowed disabled:opacity-60";

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
        disabled={refresh.isPending}
        onClick={onClick}
        title={title}
        aria-label="Refresh item"
        className={ghostClass}
      >
        <RefreshCw
          aria-hidden="true"
          className={`size-4 ${refresh.isPending ? "animate-spin" : ""}`}
        />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      disabled={refresh.isPending}
      onClick={onClick}
      title={title}
      aria-label="Refresh item"
      className={xsBorderButtonClass}
    >
      <RefreshCw
        aria-hidden="true"
        className={`size-3 ${refresh.isPending ? "animate-spin" : ""}`}
      />
      Refresh
    </Button>
  );
}
