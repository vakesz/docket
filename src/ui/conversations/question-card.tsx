"use client";

import { Input } from "@headlessui/react";
import { useState } from "react";
import { metaLabelClass } from "@/lib/form-classes";
import { cn } from "@/lib/utils";

type QuestionPayload = {
  question: string;
  options: readonly string[] | null;
  multiSelect: boolean;
};

const OTHER_LABEL = "Other";

/**
 * Inline `ask_user_question` card. The agent loop pauses the turn until
 * the user picks options or types free text; submission goes back through
 * the chat-pane's `send()` so the answer lands as the next user message.
 */
export function QuestionCard({
  question,
  disabled = false,
  onSubmit,
}: {
  question: QuestionPayload;
  disabled?: boolean;
  onSubmit: (answer: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [other, setOther] = useState("");

  const hasOptions = question.options && question.options.length > 0;
  const ready = selected.size > 0 || other.trim().length > 0;

  const toggle = (label: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (question.multiSelect) {
        if (next.has(label)) next.delete(label);
        else next.add(label);
      } else {
        next.clear();
        if (!prev.has(label)) next.add(label);
      }
      return next;
    });
    if (!question.multiSelect) setOther("");
  };

  const submit = () => {
    if (!ready) return;
    const parts: string[] = [];
    if (selected.size > 0) parts.push([...selected].join(", "));
    if (other.trim()) parts.push(other.trim());
    onSubmit(parts.join(" — "));
  };

  return (
    <section className="rounded border border-accent bg-surface p-3 text-sm text-fg">
      <header className="mb-2 flex items-center gap-2">
        <span className="rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent-fg">
          ask
        </span>
        <span className="font-mono text-[11px] text-fg-muted">Awaiting your answer</span>
        {question.multiSelect && (
          <span className={cn("ml-auto", metaLabelClass)}>multi-select</span>
        )}
      </header>
      <p className="whitespace-pre-wrap">{question.question}</p>
      {hasOptions && (
        <div className="mt-3 flex flex-wrap gap-2">
          {question.options?.map((opt) => {
            const active = selected.has(opt);
            return (
              <button
                key={opt}
                type="button"
                disabled={disabled}
                onClick={() => toggle(opt)}
                className={cn(
                  "rounded border px-2 py-1 text-xs",
                  active
                    ? "border-accent bg-accent text-accent-fg"
                    : "border-border bg-bg text-fg hover:bg-surface-alt",
                  disabled && "opacity-60",
                )}
              >
                {opt}
              </button>
            );
          })}
        </div>
      )}
      <Input
        type="text"
        disabled={disabled}
        value={other}
        placeholder={hasOptions ? `${OTHER_LABEL}…` : "Your answer…"}
        onChange={(e) => {
          setOther(e.target.value);
          if (!question.multiSelect) setSelected(new Set());
        }}
        className="mt-3 w-full rounded border border-border bg-bg px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none disabled:bg-surface-alt"
      />
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={disabled || !ready}
          onClick={submit}
          className="rounded bg-accent px-3 py-1 text-xs font-semibold text-accent-fg hover:opacity-90 disabled:opacity-60"
        >
          {disabled ? "Sending…" : "Submit"}
        </button>
      </div>
    </section>
  );
}
