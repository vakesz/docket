import type { DTO } from "~/api/client";
import { useProposeTransition } from "~/api/hooks";
import { cn } from "~/lib/cn";
import { formatIntent } from "~/lib/format";

const INTENTS: DTO["TransitionIntent"][] = [
  "start_work",
  "pause",
  "block",
  "needs_info",
  "close_done",
  "close_wontfix",
  "reopen",
];

export function TransitionBar({
  itemId,
  onStaged,
}: {
  itemId: string;
  onStaged: (proposal: DTO["ProposalDTO"]) => void;
}) {
  const propose = useProposeTransition();

  return (
    <div className="flex flex-wrap gap-1">
      {INTENTS.map((intent) => (
        <button
          type="button"
          key={intent}
          disabled={propose.isPending}
          onClick={() =>
            propose.mutate(
              { itemId, intent },
              {
                onSuccess: (p) => onStaged(p),
              },
            )
          }
          className={cn(
            "rounded border border-zinc-200 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
            "text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900",
          )}
        >
          {formatIntent(intent)}
        </button>
      ))}
    </div>
  );
}
