import { useState } from "react";
import type { DTO } from "~/api/client";
import { cn } from "~/lib/cn";
import { metaLabelClass } from "~/lib/formClasses";

interface Props {
  question: DTO["QuestionDTO"];
  onSubmit: (answers: DTO["QuestionAnswerDTO"][]) => void;
  disabled?: boolean;
}

interface ItemDraft {
  selected: Set<string>;
  other: string;
}

const OTHER_LABEL = "Other";

/**
 * Renders a structured `ask_user` question inline in the chat. The user picks
 * options (single or multi-select) and/or types into the "Other" field; on
 * submit, the parent re-streams the conversation via `/answer`. The card is
 * intentionally inert after submit (the parent unmounts it once the resume
 * stream completes) — no per-card spinner.
 */
export function QuestionCard({ question, onSubmit, disabled = false }: Props) {
  const [drafts, setDrafts] = useState<ItemDraft[]>(() =>
    question.questions.map(() => ({ selected: new Set<string>(), other: "" })),
  );

  const ready = drafts.every((d, i) => {
    const item = question.questions[i];
    if (!item) return false;
    return d.selected.size > 0 || (item.allow_other && d.other.trim().length > 0);
  });

  const updateDraft = (idx: number, fn: (d: ItemDraft) => ItemDraft) => {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? fn(d) : d)));
  };

  const toggleOption = (idx: number, label: string, multi: boolean) => {
    updateDraft(idx, (d) => {
      const next = new Set(d.selected);
      if (multi) {
        if (next.has(label)) next.delete(label);
        else next.add(label);
      } else {
        // Single-select: clicking a chosen option clears it; clicking another
        // replaces. Either way, picking a real option drops any "Other" text.
        next.clear();
        if (!d.selected.has(label)) next.add(label);
      }
      return { selected: next, other: multi ? d.other : "" };
    });
  };

  const updateOther = (idx: number, value: string, multi: boolean) => {
    updateDraft(idx, (d) => {
      // Single-select: typing in "Other" clears any selected option.
      const selected = multi ? d.selected : new Set<string>();
      return { selected, other: value };
    });
  };

  const handleSubmit = () => {
    const answers: DTO["QuestionAnswerDTO"][] = drafts.map((d) => ({
      selected: [...d.selected],
      other: d.other.trim() ? d.other.trim() : null,
    }));
    onSubmit(answers);
  };

  return (
    <section className="mb-3 rounded border border-accent bg-surface p-3 text-sm text-fg">
      <header className="mb-2 flex items-center gap-2">
        <span className="rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-bg">
          ask
        </span>
        <span className="font-mono text-[11px] text-fg-muted">Awaiting your answer</span>
      </header>
      <div className="flex flex-col gap-3">
        {question.questions.map((item, idx) => {
          const draft = drafts[idx];
          if (!draft) return null;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: questions array is fixed for the lifetime of one Question; idx pairs each item with its draft slot.
            <fieldset key={`${question.id}-${idx}`} className="flex flex-col gap-2">
              <legend className={cn("flex items-center gap-2", metaLabelClass)}>
                <span className="rounded border border-border px-1 py-0.5 text-fg">
                  {item.header}
                </span>
                <span className="text-fg-faint">
                  {item.multi_select ? "multi-select" : "pick one"}
                </span>
              </legend>
              <p className="text-sm text-fg">{item.question}</p>
              <div className="flex flex-wrap gap-2">
                {item.options.map((opt) => {
                  const active = draft.selected.has(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      disabled={disabled}
                      onClick={() => toggleOption(idx, opt.label, item.multi_select)}
                      title={opt.description || undefined}
                      className={cn(
                        "rounded border px-2 py-1 text-xs",
                        active
                          ? "border-accent bg-accent text-bg"
                          : "border-border bg-bg text-fg hover:bg-surface-alt",
                        disabled && "opacity-60",
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              {item.allow_other && (
                <input
                  type="text"
                  disabled={disabled}
                  value={draft.other}
                  placeholder={`${OTHER_LABEL}…`}
                  onChange={(e) => updateOther(idx, e.target.value, item.multi_select)}
                  className="w-full rounded border border-border bg-bg px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none disabled:bg-surface-alt"
                />
              )}
            </fieldset>
          );
        })}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={disabled || !ready}
          onClick={handleSubmit}
          className="rounded bg-accent px-3 py-1 text-xs font-semibold text-bg hover:opacity-90 disabled:opacity-60"
        >
          {disabled ? "Sending…" : "Submit"}
        </button>
      </div>
    </section>
  );
}
