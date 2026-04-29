"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";

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
    <section className="rounded border border-primary bg-card p-3 text-sm text-foreground">
      <header className="mb-2 flex items-center gap-2">
        <span className="rounded bg-primary px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary-foreground">
          ask
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">Awaiting your answer</span>
        {question.multiSelect && (
          <span className="ml-auto text-xs uppercase tracking-wide text-muted-foreground">
            multi-select
          </span>
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
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-foreground hover:bg-muted",
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
        className="mt-3"
      />
      <div className="mt-3 flex justify-end">
        <Button type="button" size="xs" disabled={disabled || !ready} onClick={submit}>
          {disabled ? "Sending…" : "Submit"}
        </Button>
      </div>
    </section>
  );
}
