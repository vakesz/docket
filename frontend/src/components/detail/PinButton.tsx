import { useIsPinned, usePin, useUnpin } from "~/api/hooks";
import { cn } from "~/lib/cn";

export function PinButton({ itemId }: { itemId: string }) {
  const state = useIsPinned(itemId);
  const pin = usePin();
  const unpin = useUnpin();
  const pinned = state.data?.pinned ?? false;
  const busy = pin.isPending || unpin.isPending;

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => (pinned ? unpin.mutate(itemId) : pin.mutate(itemId))}
      className={cn(
        "rounded border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider",
        pinned
          ? "border-accent bg-accent/10 text-accent"
          : "border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900",
      )}
    >
      {pinned ? "Pinned" : "Pin"}
    </button>
  );
}
