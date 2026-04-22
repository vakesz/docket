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
            "cursor-pointer rounded border border-border bg-surface px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider shadow-sm transition-colors",
            "text-fg-muted hover:border-accent hover:bg-accent hover:text-accent-fg",
            "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-surface disabled:hover:text-fg-muted",
          )}
        >
          {formatIntent(intent)}
        </button>
      ))}
    </div>
  );
}
