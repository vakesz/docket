import { FileText, RotateCcw, Save, Search, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { usePrompt, usePrompts, usePutPrompt, useResetPrompt } from "~/api/hooks";
import type { components } from "~/api/schema";
import { StatusPill } from "~/components/common/FormInputs";
import { MarkdownEditor } from "~/components/common/MarkdownEditor";
import { Notice } from "~/components/common/Notice";
import { cn } from "~/lib/cn";
import { outlineButtonClass, primaryButtonClass } from "~/lib/formClasses";

type PromptSummary = components["schemas"]["PromptSummaryDTO"];

type PromptFilter = "all" | "customized" | "default";

const PROMPT_FILTERS: { value: PromptFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "customized", label: "Edited" },
  { value: "default", label: "Default" },
];

export function PromptsPanel() {
  const prompts = usePrompts();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PromptFilter>("all");

  const list = prompts.data ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((p) => {
      if (filter === "customized" && !p.customized) return false;
      if (filter === "default" && p.customized) return false;
      if (!q) return true;
      return (
        p.label.toLowerCase().includes(q) ||
        p.key.toLowerCase().includes(q) ||
        p.filename.toLowerCase().includes(q)
      );
    });
  }, [list, query, filter]);

  useEffect(() => {
    if (!list.length) return;
    if (!selected || !list.some((p) => p.key === selected)) {
      setSelected(filtered[0]?.key ?? list[0]?.key);
    }
  }, [list, filtered, selected]);

  if (prompts.isPending && !prompts.data) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
        Loading prompts…
      </div>
    );
  }
  if (prompts.error) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Notice tone="error" title="Prompts unavailable">
          {prompts.error.message}
        </Notice>
      </div>
    );
  }
  if (list.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-fg-muted">
        No prompt templates registered.
      </div>
    );
  }

  const customizedCount = list.filter((p) => p.customized).length;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-hidden border-b border-border bg-surface/60 md:border-b-0 md:border-r">
        <div className="px-3 pb-3 pt-4">
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-fg-muted">
              Templates
            </div>
            <span className="font-mono text-[10px] text-fg-faint">
              {list.length}
              {customizedCount > 0 ? ` · ${customizedCount} edited` : ""}
            </span>
          </div>
          <label className="relative block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search prompts…"
              className="w-full rounded-xl border border-border bg-surface py-1.5 pl-8 pr-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none-muted"
            />
          </label>
          <div className="mt-2 grid grid-cols-3 gap-1 rounded-xl bg-surface-alt p-1">
            {PROMPT_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={cn(
                  "rounded-lg px-2 py-1 text-xs font-medium transition-colors",
                  filter === f.value
                    ? "bg-surface text-fg shadow-sm-alt"
                    : "text-fg-muted hover:text-fg-faint",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <nav className="min-h-0 flex-1 overflow-auto px-2 pb-3">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-fg-muted">
              No prompts match this filter.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {filtered.map((p) => (
                <PromptListItem
                  key={p.key}
                  prompt={p}
                  active={selected === p.key}
                  onSelect={() => setSelected(p.key)}
                />
              ))}
            </ul>
          )}
        </nav>
      </aside>

      {selected ? (
        <PromptEditor key={selected} promptKey={selected} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
          Select a prompt to start editing.
        </div>
      )}
    </div>
  );
}

function PromptListItem({
  prompt,
  active,
  onSelect,
}: {
  prompt: PromptSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "group flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left transition-colors",
          active ? "bg-accent/10 text-accent" : "text-fg hover:bg-surface-alt",
        )}
      >
        <FileText
          className={cn("mt-0.5 h-4 w-4 shrink-0", active ? "text-accent" : "text-fg-faint")}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{prompt.label}</span>
            {prompt.customized && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" title="Customized" />
            )}
          </div>
          <div
            className={cn(
              "truncate font-mono text-[10px]",
              active ? "text-accent/80" : "text-fg-muted",
            )}
          >
            {prompt.filename}
          </div>
        </div>
      </button>
    </li>
  );
}

function PromptEditor({ promptKey }: { promptKey: string }) {
  const prompt = usePrompt(promptKey);
  const put = usePutPrompt();
  const reset = useResetPrompt();
  const [draft, setDraft] = useState<string>("");
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    if (prompt.data) setDraft(prompt.data.content_md);
  }, [prompt.data]);

  const dirty = !!prompt.data && draft !== prompt.data.content_md;
  const canSave = dirty && !put.isPending;

  const save = useCallback(() => {
    if (!canSave) return;
    put.mutate({ key: promptKey, contentMd: draft });
  }, [canSave, draft, promptKey, put]);

  const revert = useCallback(() => {
    if (!prompt.data) return;
    setDraft(prompt.data.content_md);
    put.reset();
  }, [prompt.data, put]);

  const onReset = useCallback(() => {
    if (!prompt.data?.customized) return;
    const ok = window.confirm(
      `Reset “${prompt.data.label}” to the bundled default?\n\nYour edits to ${prompt.data.filename} will be discarded.`,
    );
    if (!ok) return;
    reset.mutate(promptKey);
  }, [prompt.data, promptKey, reset]);

  // Cmd/Ctrl+S inside the prompts editor saves the prompt, not the config.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (canSave) save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSave, save]);

  useEffect(() => {
    if (!put.isSuccess || dirty) return;
    setSavedFlash(true);
    const id = window.setTimeout(() => setSavedFlash(false), 2200);
    return () => window.clearTimeout(id);
  }, [put.isSuccess, dirty]);

  if (prompt.isPending && !prompt.data) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
        Loading prompt…
      </div>
    );
  }
  if (prompt.error) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Notice tone="error" title="Failed to load prompt">
          {prompt.error.message}
        </Notice>
      </div>
    );
  }
  if (!prompt.data) return null;

  const { label, filename, content_md, customized } = prompt.data;
  const lineCount = draft ? draft.split("\n").length : 0;
  const charCount = draft.length;
  const baseLineCount = content_md.split("\n").length;
  const delta = lineCount - baseLineCount;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-start gap-3 border-b border-border bg-surface/70 px-6 py-4 backdrop-blur">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-fg">{label}</h2>
            <StatusPill
              tone={dirty ? "warn" : savedFlash ? "ok" : "muted"}
              label={dirty ? "Unsaved changes" : savedFlash ? "Saved" : "Up to date"}
            />
            {customized && !dirty && (
              <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
                Customized
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-fg-muted">
            <span className="truncate">{filename}</span>
            <span aria-hidden>·</span>
            <span>
              {lineCount} line{lineCount === 1 ? "" : "s"}
            </span>
            <span aria-hidden>·</span>
            <span>{charCount.toLocaleString()} chars</span>
            {dirty && delta !== 0 && (
              <>
                <span aria-hidden>·</span>
                <span className={delta > 0 ? "text-success-fg" : "text-danger-fg"}>
                  {delta > 0 ? `+${delta}` : delta} lines
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onReset}
            disabled={!customized || reset.isPending || dirty}
            title={
              dirty
                ? "Revert your unsaved changes first"
                : !customized
                  ? "This prompt is already the bundled default"
                  : "Restore the bundled default content"
            }
            className={outlineButtonClass}
          >
            <Sparkles className="h-4 w-4" />
            {reset.isPending ? "Resetting…" : "Reset to default"}
          </button>
          <button type="button" onClick={revert} disabled={!dirty} className={outlineButtonClass}>
            <RotateCcw className="h-4 w-4" />
            Revert
          </button>
          <button type="button" onClick={save} disabled={!canSave} className={primaryButtonClass}>
            <Save className="h-4 w-4" />
            {put.isPending ? "Saving…" : "Save changes"}
            <span className="ml-1 hidden font-mono text-[10px] opacity-70 sm:inline">⌘S</span>
          </button>
        </div>
      </header>

      {(put.error || reset.error) && (
        <div className="border-b border-border bg-bg/60 px-6 py-3">
          <Notice tone="error" title={put.error ? "Save failed" : "Reset failed"}>
            {(put.error ?? reset.error)?.message ?? "Unknown error"}
          </Notice>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden bg-bg">
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          height="100%"
          lineNumbers
          foldGutter
          highlightActiveLine
          highlightActiveLineGutter
          lineWrapping
          className="h-full text-[13px]"
        />
      </div>
    </div>
  );
}
