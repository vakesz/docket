"use client";

import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";

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

  return (
    <Button
      variant={pinned ? "secondary" : "outline"}
      size="sm"
      disabled={busy}
      onClick={() => {
        if (pinned) {
          unpin.mutate({ projectId, providerItemId });
        } else {
          pin.mutate({ projectId, providerItemId });
        }
      }}
    >
      {busy ? "…" : label}
    </Button>
  );
}
