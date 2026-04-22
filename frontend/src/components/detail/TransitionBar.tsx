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
            "cursor-pointer rounded border border-zinc-300 bg-white px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider shadow-sm transition-colors",
            "text-zinc-700 hover:border-accent hover:bg-accent hover:text-white",
            "dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-accent dark:hover:bg-accent dark:hover:text-white",
            "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-zinc-300 disabled:hover:bg-white disabled:hover:text-zinc-700 dark:disabled:hover:border-zinc-700 dark:disabled:hover:bg-zinc-900 dark:disabled:hover:text-zinc-300",
          )}
        >
          {formatIntent(intent)}
        </button>
      ))}
    </div>
  );
}
