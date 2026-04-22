import { useState } from "react";
import type { DTO } from "~/api/client";
import { useStageSuggestion, useSuggestion } from "~/api/hooks";
import { cn } from "~/lib/cn";
import { formatIntent } from "~/lib/format";
import { Markdown } from "./Markdown";

interface Props {
  itemId: string;
  onStaged: (proposals: DTO["ProposalDTO"][]) => void;
}

export function SuggestBlock({ itemId, onStaged }: Props) {
  const getSuggestion = useSuggestion();
  const stage = useStageSuggestion();
  const [suggestion, setSuggestion] = useState<DTO["SuggestionDTO"] | null>(null);

  return (
    <div className="flex flex-col gap-2 rounded border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">
          Suggest next action
        </span>
        <button
          type="button"
          disabled={getSuggestion.isPending}
          onClick={() => getSuggestion.mutate(itemId, { onSuccess: (s) => setSuggestion(s) })}
          className={cn(
            "ml-auto rounded border border-zinc-200 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
            "text-zinc-700 hover:bg-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800",
          )}
        >
          {getSuggestion.isPending ? "Thinking…" : suggestion ? "Re-run" : "Suggest"}
        </button>
      </div>

      {getSuggestion.error && (
        <div className="text-xs text-rose-600 dark:text-rose-400">
          {getSuggestion.error.message}
        </div>
      )}

      {suggestion && (
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent">
              {formatIntent(suggestion.intent)}
            </span>
          </div>
          {suggestion.description_patch_md && <Markdown source={suggestion.description_patch_md} />}
          {(suggestion.open_questions?.length ?? 0) > 0 && (
            <ul className="list-disc pl-4 text-xs text-zinc-600 dark:text-zinc-400">
              {suggestion.open_questions?.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              disabled={stage.isPending}
              onClick={() =>
                stage.mutate(
                  {
                    itemId,
                    body: {
                      intent: suggestion.intent,
                      description_patch_md: suggestion.description_patch_md,
                    },
                  },
                  { onSuccess: (list) => onStaged(list) },
                )
              }
              className="rounded bg-accent px-3 py-1 text-xs font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {stage.isPending ? "Staging…" : "Stage proposal(s)"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
