"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useGlobalSettingsMap } from "@/lib/settings-client";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import { Label } from "@/ui/primitives/label";
import { Textarea } from "@/ui/primitives/textarea";

/**
 * Deployment-wide editor for the agent's prompts. Each entry maps to one
 * global setting; clearing the field (empty string) lets the loader fall
 * back to the source-baked default.
 *
 * Layout: left rail picks one prompt at a time, the right pane edits it.
 * Drafts persist across rail switches so the user can flip between
 * prompts mid-edit without losing work; "Save all" commits every dirty
 * draft in one go.
 *
 * Edits invalidate the prompt cache once — the prefix is byte-stable for
 * any given configuration, so it stabilises again on the next turn.
 */

type PromptKey =
  | "prompt.system-base"
  | "prompt.kind.epic"
  | "prompt.kind.feature"
  | "prompt.kind.story"
  | "prompt.kind.task"
  | "prompt.kind.bug"
  | "prompt.suggest-next-action"
  | "prompt.guardrail.injection"
  | "prompt.guardrail.scope"
  | "prompt.guardrail.output-safety";

type PromptGroup = "system" | "kind" | "seed" | "guardrail";

type FieldDef = {
  key: PromptKey;
  group: PromptGroup;
  navLabel: string;
  label: string;
  hint: string;
  rows: number;
};

const FIELDS: readonly FieldDef[] = [
  {
    key: "prompt.system-base",
    group: "system",
    navLabel: "System base",
    label: "Agent system prompt",
    hint: "The base instructions every turn opens with. Persona, mutation tool guidance, recommendation modes, honesty rules. Empty falls back to the bundled default.",
    rows: 28,
  },
  {
    key: "prompt.kind.epic",
    group: "kind",
    navLabel: "Epic",
    label: "Kind prompt — epic",
    hint: "Appended when the active item is an epic. Empty falls back to the bundled default.",
    rows: 6,
  },
  {
    key: "prompt.kind.feature",
    group: "kind",
    navLabel: "Feature",
    label: "Kind prompt — feature",
    hint: "Appended when the active item is a feature. Empty falls back to the bundled default.",
    rows: 6,
  },
  {
    key: "prompt.kind.story",
    group: "kind",
    navLabel: "Story",
    label: "Kind prompt — story",
    hint: "Appended when the active item is a story. Empty falls back to the bundled default.",
    rows: 6,
  },
  {
    key: "prompt.kind.task",
    group: "kind",
    navLabel: "Task",
    label: "Kind prompt — task",
    hint: "Appended when the active item is a task. Empty falls back to the bundled default.",
    rows: 6,
  },
  {
    key: "prompt.kind.bug",
    group: "kind",
    navLabel: "Bug",
    label: "Kind prompt — bug",
    hint: "Appended when the active item is a bug. Empty falls back to the bundled default.",
    rows: 8,
  },
  {
    key: "prompt.suggest-next-action",
    group: "seed",
    navLabel: "Suggest next action",
    label: "Suggest next action — instructions",
    hint: "Instructional middle of the seed message the chat pane fires when a user clicks 'Suggest next action' on the item header. The seed builder wraps this in dynamic context (title, kind/state hints, body excerpt, comment count). Empty falls back to the bundled default.",
    rows: 18,
  },
  {
    key: "prompt.guardrail.injection",
    group: "guardrail",
    navLabel: "Tool-result injection",
    label: "Guardrail prompt — tool-result injection check",
    hint: "System prompt the LLM-judge uses when classifying tool output as safe / suspicious / injection. Must keep the three label tokens reachable so the judge's verdict match still works. Empty falls back to the bundled default.",
    rows: 18,
  },
  {
    key: "prompt.guardrail.scope",
    group: "guardrail",
    navLabel: "Input scope",
    label: "Guardrail prompt — input scope check",
    hint: "System prompt the LLM-judge uses when classifying user messages as on-topic / off-topic. Must keep the two label tokens reachable. Empty falls back to the bundled default.",
    rows: 18,
  },
  {
    key: "prompt.guardrail.output-safety",
    group: "guardrail",
    navLabel: "Output safety",
    label: "Guardrail prompt — output safety check",
    hint: "System prompt the LLM-judge uses when classifying the assistant's final reply as safe / unsafe. Must keep the two label tokens reachable. Empty falls back to the bundled default.",
    rows: 8,
  },
];

const GROUPS: { key: PromptGroup; label: string }[] = [
  { key: "system", label: "System" },
  { key: "kind", label: "Per-kind prefixes" },
  { key: "seed", label: "Seeds" },
  { key: "guardrail", label: "Guardrail (LLM judge)" },
];

export function PromptsPanel() {
  const utils = trpc.useUtils();
  const settings = useGlobalSettingsMap();

  const [drafts, setDrafts] = useState<Record<PromptKey, string>>(() => emptyDrafts());
  const [active, setActive] = useState<PromptKey>(FIELDS[0]?.key ?? "prompt.system-base");

  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (!settings.list.data) return;
    const next = emptyDrafts();
    for (const field of FIELDS) {
      next[field.key] = settings.str(field.key, "");
    }
    setDrafts(next);
    seededRef.current = true;
  }, [settings]);

  const update = trpc.settings.globalUpdate.useMutation({
    onSuccess: async () => {
      await utils.settings.globalList.invalidate();
    },
  });
  const reset = trpc.settings.globalReset.useMutation({
    onSuccess: async () => {
      await utils.settings.globalList.invalidate();
    },
  });

  const onSaveAll = async (e: React.FormEvent) => {
    e.preventDefault();
    await Promise.all(FIELDS.map((f) => update.mutateAsync({ key: f.key, value: drafts[f.key] })));
  };

  const onResetAll = async () => {
    await Promise.all(FIELDS.map((f) => reset.mutateAsync({ key: f.key })));
    seededRef.current = false;
  };

  const onResetActive = async () => {
    await reset.mutateAsync({ key: active });
    seededRef.current = false;
  };

  if (settings.list.isPending) {
    return <p className="text-muted-foreground/70 text-sm">Loading…</p>;
  }

  const activeField = FIELDS.find((f) => f.key === active) ?? FIELDS[0];
  if (!activeField) {
    throw new Error("prompts panel rendered with empty FIELDS list");
  }
  const dirty = settings.list.data
    ? FIELDS.some((f) => drafts[f.key] !== settings.str(f.key, ""))
    : false;

  return (
    <form onSubmit={onSaveAll} className="grid gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
      <nav className="flex flex-col gap-4 self-start md:sticky md:top-4">
        {GROUPS.map((group) => {
          const items = FIELDS.filter((f) => f.group === group.key);
          if (items.length === 0) return null;
          return (
            <div key={group.key} className="flex flex-col gap-1">
              <div className="px-2 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
                {group.label}
              </div>
              {items.map((field) => (
                <button
                  key={field.key}
                  type="button"
                  onClick={() => setActive(field.key)}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    active === field.key
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                  aria-current={active === field.key ? "true" : undefined}
                >
                  {field.navLabel}
                </button>
              ))}
            </div>
          );
        })}
      </nav>

      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground text-xs">
          Edits take effect on the next conversation turn. The prefix stays byte-stable for any
          given configuration, so the prompt cache stabilises again immediately after you save.
        </p>

        <PromptField
          field={activeField}
          value={drafts[activeField.key]}
          disabled={update.isPending || reset.isPending}
          onChange={(next) => setDrafts((prev) => ({ ...prev, [activeField.key]: next }))}
        />

        <div className="flex flex-wrap items-center gap-3 border-border border-t pt-4">
          <Button type="submit" disabled={update.isPending || reset.isPending || !dirty}>
            {update.isPending ? "Saving…" : "Save all"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={update.isPending || reset.isPending}
            onClick={onResetActive}
          >
            Reset this prompt
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={update.isPending || reset.isPending}
            onClick={onResetAll}
          >
            {reset.isPending ? "Resetting…" : "Reset all to defaults"}
          </Button>
          {update.isSuccess && !dirty ? (
            <span className="text-muted-foreground text-xs">Saved.</span>
          ) : null}
        </div>

        {update.error ? (
          <Alert variant="destructive">
            <AlertDescription>{update.error.message}</AlertDescription>
          </Alert>
        ) : null}
        {reset.error ? (
          <Alert variant="destructive">
            <AlertDescription>{reset.error.message}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </form>
  );
}

function PromptField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: FieldDef;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} className="font-medium text-foreground text-sm">
        {field.label}
      </Label>
      <p className="text-muted-foreground text-xs">{field.hint}</p>
      <Textarea
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        rows={field.rows}
        className="font-mono text-xs"
      />
    </div>
  );
}

function emptyDrafts(): Record<PromptKey, string> {
  return {
    "prompt.system-base": "",
    "prompt.kind.epic": "",
    "prompt.kind.feature": "",
    "prompt.kind.story": "",
    "prompt.kind.task": "",
    "prompt.kind.bug": "",
    "prompt.suggest-next-action": "",
    "prompt.guardrail.injection": "",
    "prompt.guardrail.scope": "",
    "prompt.guardrail.output-safety": "",
  };
}
