"use client";

import { Pin, PinOff } from "lucide-react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";

/**
 * Pin/unpin toggle. `compact` collapses to a borderless icon-only button
 * for the detail header utility cluster; the full pill stays for places
 * that want the label (backlog rows, etc.).
 */
export function PinButton({
  projectSlug,
  providerItemId,
  compact = false,
}: {
  projectSlug: string;
  providerItemId: string;
  compact?: boolean;
}) {
  const utils = trpc.useUtils();
  const status = trpc.watchlist.isPinned.useQuery(
    { projectSlug, providerItemId },
    { staleTime: 0 },
  );

  const onSuccess = async () => {
    await Promise.all([
      utils.watchlist.isPinned.invalidate({ projectSlug, providerItemId }),
      utils.watchlist.list.invalidate({ projectSlug }),
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
      unpin.mutate({ projectSlug, providerItemId });
    } else {
      pin.mutate({ projectSlug, providerItemId });
    }
  };

  if (compact) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-pressed={pinned}
        aria-label={label}
        disabled={busy}
        title={busy ? "…" : label}
        onClick={onClick}
      >
        <Icon aria-hidden="true" />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant={pinned ? "secondary" : "outline"}
      size="xs"
      aria-pressed={pinned}
      disabled={busy}
      title={busy ? "…" : label}
      onClick={onClick}
    >
      <Icon aria-hidden="true" />
      {busy ? "…" : label}
    </Button>
  );
}
