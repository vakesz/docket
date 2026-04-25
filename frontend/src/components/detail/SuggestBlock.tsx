import { useState } from "react";
import type { DTO } from "~/api/client";
import { useStageSuggestion, useStatus, useSuggestion } from "~/api/hooks";
import { useChatPaneController } from "~/components/chat/ChatPaneContext";
import { cn } from "~/lib/cn";
import { formatIntent } from "~/lib/format";
import { microCapsButtonClass, xsAccentButtonClass } from "~/lib/formClasses";
import { Markdown } from "./Markdown";

interface Props {
  itemId: string;
  onStaged: (proposals: DTO["ProposalDTO"][]) => void;
}

/** Format a suggestion as a chat draft the user can edit before sending. */
function refinementDraft(s: DTO["SuggestionDTO"]): string {
  const lines: string[] = [`About the suggested next action (${formatIntent(s.intent)}):`];
  const patch = (s.description_patch_md ?? "").trim();
  if (patch) {
    lines.push("", "Proposed description patch:", patch);
  }
  if ((s.open_questions?.length ?? 0) > 0) {
    lines.push("", "Open questions:");
    for (const q of s.open_questions ?? []) {
      lines.push(`- ${q}`);
    }
  }
  lines.push("", "I'd like to refine this before staging — what do you think?");
  return lines.join("\n");
}

export function SuggestBlock({ itemId, onStaged }: Props) {
  const getSuggestion = useSuggestion();
  const stage = useStageSuggestion();
  const status = useStatus();
  const chatController = useChatPaneController();
  const [suggestion, setSuggestion] = useState<DTO["SuggestionDTO"] | null>(null);
  const chatEnabled = status.data?.chat_enabled ?? false;

  const handleRefineInChat = () => {
    if (!suggestion) return;
    chatController.setOpen(true);
    chatController.seed(refinementDraft(suggestion));
    // Hand off completely — the suggestion now lives as an editable chat draft.
    setSuggestion(null);
  };

  return (
    <div className="flex flex-col gap-2 rounded border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-fg-muted">
          Suggest next action
        </span>
        <button
          type="button"
          disabled={getSuggestion.isPending}
          onClick={() => getSuggestion.mutate(itemId, { onSuccess: (s) => setSuggestion(s) })}
          className={cn("ml-auto", microCapsButtonClass)}
        >
          {getSuggestion.isPending ? "Thinking…" : suggestion ? "Re-run" : "Suggest"}
        </button>
      </div>

      {getSuggestion.error && (
        <div className="text-xs text-danger">{getSuggestion.error.message}</div>
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
            <ul className="list-disc pl-4 text-xs text-fg-muted">
              {suggestion.open_questions?.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          )}
          {stage.error && <div className="text-xs text-danger">{stage.error.message}</div>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={!chatEnabled}
              onClick={handleRefineInChat}
              title={
                chatEnabled
                  ? "Hand the suggestion to the chat agent so you can refine it before staging."
                  : "Chat is disabled — configure Azure OpenAI in Settings to refine suggestions."
              }
              className="rounded border border-accent bg-accent/10 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Refine in chat
            </button>
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
                  {
                    onSuccess: (list) => {
                      onStaged(list);
                      // Clear the suggestion once the proposal cards take over
                      // — otherwise the same intent/diff sits in two places at
                      // once and looks like there's still pending action here.
                      setSuggestion(null);
                    },
                  },
                )
              }
              className={xsAccentButtonClass}
            >
              {stage.isPending ? "Staging…" : "Stage proposal(s)"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
