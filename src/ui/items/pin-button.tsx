"use client";

import { Button } from "@headlessui/react";
import { Pin, PinOff } from "lucide-react";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";

const baseClass =
  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60";
const inactiveClass = "border-border bg-card text-foreground hover:bg-muted";
const activeClass = "border-border bg-muted text-foreground hover:bg-card";

const ghostClass =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:bg-muted aria-pressed:text-foreground";

/**
 * Pin/unpin toggle. `compact` collapses to a borderless icon-only button
 * for the detail header utility cluster; the full pill stays for places
 * that want the label (backlog rows, etc.).
 */
export function PinButton({
  projectId,
  providerItemId,
  compact = false,
}: {
  projectId: string;
  providerItemId: string;
  compact?: boolean;
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

  const onClick = () => {
    if (pinned) {
      unpin.mutate({ projectId, providerItemId });
    } else {
      pin.mutate({ projectId, providerItemId });
    }
  };

  if (compact) {
    return (
      <Button
        type="button"
        aria-pressed={pinned}
        aria-label={label}
        disabled={busy}
        title={busy ? "…" : label}
        className={ghostClass}
        onClick={onClick}
      >
        <Icon aria-hidden="true" className="size-4" />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      aria-pressed={pinned}
      disabled={busy}
      title={busy ? "…" : label}
      className={cn(baseClass, pinned ? activeClass : inactiveClass)}
      onClick={onClick}
    >
      <Icon aria-hidden="true" className="size-3" />
      {busy ? "…" : label}
    </Button>
  );
}
