"use client";

import { Button } from "@headlessui/react";
import { Pin, PinOff } from "lucide-react";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";

const baseClass =
  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60";
const inactiveClass = "border-border bg-surface text-fg hover:bg-surface-alt";
const activeClass = "border-border bg-surface-alt text-fg hover:bg-surface";

export function PinButton({
  projectId,
  providerItemId,
}: {
  projectId: string;
  providerItemId: string;
}) {
  const utils = trpc.useUtils();
  const status = trpc.watchlist.isPinned.useQuery({ projectId, providerItemId }, { staleTime: 0 });

  const onSuccess = async () => {
    await Promise.all([
      utils.watchlist.isPinned.invalidate({ projectId, providerItemId }),
      utils.watchlist.list.invalidate({ projectId }),
    ]);
  };
  const pin = trpc.watchlist.pin.useMutation({ onSuccess });
  const unpin = trpc.watchlist.unpin.useMutation({ onSuccess });

  const pinned = status.data?.pinned ?? false;
  const busy = pin.isPending || unpin.isPending || status.isPending;
  const label = pinned ? "Unpin" : "Pin";
  const Icon = pinned ? PinOff : Pin;

  return (
    <Button
      type="button"
      aria-pressed={pinned}
      disabled={busy}
      title={busy ? "…" : label}
      className={cn(baseClass, pinned ? activeClass : inactiveClass)}
      onClick={() => {
        if (pinned) {
          unpin.mutate({ projectId, providerItemId });
        } else {
          pin.mutate({ projectId, providerItemId });
        }
      }}
    >
      <Icon aria-hidden="true" className="size-3" />
      {busy ? "…" : label}
    </Button>
  );
}
