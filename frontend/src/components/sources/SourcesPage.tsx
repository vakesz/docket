import { FileText, Plus, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { DTO } from "~/api/client";
import {
  useActiveProject,
  useCreateSource,
  useDeleteSource,
  useSourcesList,
  useStatus,
  useUpdateSource,
} from "~/api/hooks";
import { FieldError, FormField } from "~/components/common/FormField";
import { Select, StatusPill, TextInput } from "~/components/common/FormInputs";
import { ListPlaceholder } from "~/components/common/ListPlaceholder";
import { MarkdownEditor } from "~/components/common/MarkdownEditor";
import { Notice } from "~/components/common/Notice";
import { cn } from "~/lib/cn";
import {
  dangerButtonClass,
  outlineButtonClass,
  primaryButtonClass,
  sidebarActionClass,
} from "~/lib/formClasses";

import {
  blankDraft,
  draftFromEntry,
  draftsEqual,
  KIND_PRESETS,
  type SourceDraft,
  serializeCreate,
  serializeUpdate,
} from "./sourceDraft";

/**
 * Sources page: project-scoped reference documents (requirements, design notes,
 * runbooks, etc.). The agent reads them on demand via tools but never writes.
 * Same shell as `McpPage` and `MemoryPage`.
 */
export function SourcesPage() {
  const activeProject = useActiveProject();
  const status = useStatus();
  const projectId = activeProject.data?.id;
  const list = useSourcesList(projectId);
  const readOnly = status.data?.read_only ?? false;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const entries = useMemo(() => [...(list.data?.entries ?? [])], [list.data?.entries]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally skip `creating`.
  useEffect(() => {
    if (creating) return;
    if (entries.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId && entries.some((e) => e.id === selectedId)) return;
    setSelectedId(entries[0]?.id ?? null);
  }, [entries, selectedId]);

  const selectedEntry = entries.find((e) => e.id === selectedId) ?? null;
  const draft = useMemo<SourceDraft>(
    () => (creating ? blankDraft() : selectedEntry ? draftFromEntry(selectedEntry) : blankDraft()),
    [creating, selectedEntry],
  );

  const startNewDraft = () => {
    if (readOnly) return;
    setCreating(true);
    setSelectedId(null);
  };
  const onSelect = (id: string) => {
    setCreating(false);
    setSelectedId(id);
  };
  const onDeleted = () => {
    setCreating(false);
    setSelectedId(null);
  };
  const onCreated = (id: string) => {
    setCreating(false);
    setSelectedId(id);
  };

  if (activeProject.isPending || status.isPending) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-muted">Loading…</div>
    );
  }
  if (activeProject.error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-danger">
        {activeProject.error.message}
      </div>
    );
  }
  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-fg-muted">
        No active project.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-bg">
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col overflow-hidden border-b border-border bg-surface/80 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-2 border-b border-border px-4 py-4">
            <div className="rounded-xl bg-accent/10 p-2 text-accent">
              <FileText className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-fg">Sources</h1>
              <p className="truncate text-[11px] text-fg-muted">
                Project <code className="font-mono">{projectId}</code>
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2 px-3 py-3">
            <button
              type="button"
              onClick={startNewDraft}
              disabled={readOnly}
              className={sidebarActionClass}
              title={readOnly ? "Read-only mode" : "Add a new source document"}
            >
              <Plus className="h-4 w-4" />
              New source
            </button>
          </div>

          <nav className="min-h-0 flex-1 overflow-auto px-2 pb-3">
            {list.isPending ? (
              <ListPlaceholder>Loading sources…</ListPlaceholder>
            ) : list.error ? (
              <ListPlaceholder tone="error">{list.error.message}</ListPlaceholder>
            ) : entries.length === 0 ? (
              <ListPlaceholder>No source documents yet.</ListPlaceholder>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {entries.map((entry) => (
                  <SourceListItem
                    key={entry.id}
                    entry={entry}
                    active={!creating && entry.id === selectedId}
                    onSelect={() => onSelect(entry.id)}
                  />
                ))}
              </ul>
            )}
          </nav>
        </aside>

        <section className="flex min-h-0 flex-col overflow-hidden">
          {creating || selectedEntry ? (
            <SourceEntryForm
              key={creating ? "__new__" : (selectedEntry?.id ?? "__none__")}
              projectId={projectId}
              draft={draft}
              entryId={creating ? null : (selectedEntry?.id ?? null)}
              mode={creating ? "create" : "edit"}
              readOnly={readOnly}
              onCreated={onCreated}
              onDeleted={onDeleted}
            />
          ) : (
            <EmptySourcesState
              hasEntries={entries.length > 0}
              readOnly={readOnly}
              onCreate={startNewDraft}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function EmptySourcesState({
  hasEntries,
  readOnly,
  onCreate,
}: {
  hasEntries: boolean;
  readOnly: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="rounded-2xl bg-accent/10 p-3 text-accent">
          <FileText className="h-6 w-6" />
        </div>
        <div className="flex flex-col gap-1.5">
          <h3 className="text-base font-semibold text-fg">
            {hasEntries ? "No source selected" : "No source documents yet"}
          </h3>
          <p className="text-sm leading-6 text-fg-muted">
            {hasEntries
              ? "Pick a source on the left to edit, or add a new one."
              : "Reference docs the agent reads on demand — requirements, design notes, runbooks. Long-form is fine; sources don't ship in every prompt."}
          </p>
        </div>
        {!hasEntries && (
          <button
            type="button"
            onClick={onCreate}
            disabled={readOnly}
            className={primaryButtonClass}
            title={readOnly ? "Read-only mode" : "Add a new source document"}
          >
            <Plus className="h-4 w-4" />
            Add your first source
          </button>
        )}
        {readOnly && !hasEntries && (
          <p className="text-xs text-fg-muted">Read-only mode is on — saves are disabled.</p>
        )}
      </div>
    </div>
  );
}

function SourceListItem({
  entry,
  active,
  onSelect,
}: {
  entry: DTO["SourceDTO"];
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "group flex w-full flex-col gap-0.5 rounded-xl px-3 py-2 text-left transition-colors",
          active ? "bg-accent/10 text-accent" : "text-fg hover:bg-surface-alt",
        )}
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{entry.title}</span>
        </div>
        <div
          className={cn(
            "truncate font-mono text-[10px]",
            active ? "text-accent/80" : "text-fg-muted",
          )}
        >
          {entry.kind || "uncategorized"}
        </div>
      </button>
    </li>
  );
}

function SourceEntryForm({
  projectId,
  draft: initialDraft,
  entryId,
  mode,
  readOnly,
  onCreated,
  onDeleted,
}: {
  projectId: string;
  draft: SourceDraft;
  entryId: string | null;
  mode: "create" | "edit";
  readOnly: boolean;
  onCreated?: (id: string) => void;
  onDeleted?: () => void;
}) {
  const create = useCreateSource(projectId);
  const update = useUpdateSource(projectId);
  const del = useDeleteSource(projectId);

  const [draft, setDraft] = useState<SourceDraft>(initialDraft);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on identity swap, not live mutations.
  useEffect(() => {
    setDraft(initialDraft);
    create.reset();
    update.reset();
    del.reset();
  }, [initialDraft]);

  const titleError = draft.title.trim().length === 0 ? "Title is required." : null;
  const dirty = useMemo(() => !draftsEqual(draft, initialDraft), [draft, initialDraft]);

  const save = useCallback(async () => {
    if (readOnly || titleError) return;
    if (mode === "create") {
      const created = await create.mutateAsync(serializeCreate(draft));
      onCreated?.(created.id);
    } else if (entryId) {
      await update.mutateAsync({ sourceId: entryId, body: serializeUpdate(draft) });
    }
  }, [create, draft, entryId, mode, onCreated, readOnly, titleError, update]);

  const onDelete = useCallback(async () => {
    if (readOnly || mode !== "edit" || !entryId) return;
    const ok = window.confirm(
      `Delete source “${initialDraft.title || "(untitled)"}”?\n\nThis cannot be undone.`,
    );
    if (!ok) return;
    await del.mutateAsync(entryId);
    onDeleted?.();
  }, [del, entryId, initialDraft.title, mode, onDeleted, readOnly]);

  const saving = create.isPending || update.isPending;
  const deleting = del.isPending;
  const saveError = create.error ?? update.error;
  const deleteError = del.error;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!readOnly && !titleError && !saving && (dirty || mode === "create")) {
          void save();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, mode, readOnly, save, saving, titleError]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border bg-surface/70 px-6 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-lg font-semibold text-fg">
            {mode === "create" ? "New source" : initialDraft.title || "(untitled)"}
          </h2>
          <StatusPill
            tone={mode === "create" ? "muted" : dirty ? "warn" : "ok"}
            label={mode === "create" ? "Unsaved draft" : dirty ? "Unsaved changes" : "Up to date"}
          />
        </div>
        <p className="mt-1 text-sm text-fg-muted">
          {mode === "create"
            ? "Reference doc the agent can read on demand. Long-form is fine — sources don't ship in every prompt."
            : "Edit the document. Sources are read by the agent through tools, not the prompt prefix."}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          {readOnly && (
            <Notice tone="warning" title="Read-only mode">
              Saves and deletes are disabled.
            </Notice>
          )}
          {saveError && (
            <Notice tone="error" title="Save failed">
              {saveError.message}
            </Notice>
          )}
          {deleteError && (
            <Notice tone="error" title="Delete failed">
              {deleteError.message}
            </Notice>
          )}

          <section className="flex flex-col gap-5 rounded-2xl border border-border bg-surface p-6 shadow-sm">
            <FormField label="Title">
              <TextInput
                value={draft.title}
                onChange={(v) => setDraft((d) => ({ ...d, title: v }))}
                placeholder="Document title…"
              />
              {titleError && <FieldError>{titleError}</FieldError>}
            </FormField>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Kind" help="Free-text category. Pick a preset or type your own.">
                <Select
                  value={draft.kind}
                  options={KIND_PRESETS}
                  allowCustom
                  placeholder="— choose —"
                  onChange={(v) => setDraft((d) => ({ ...d, kind: v }))}
                />
              </FormField>
              <FormField
                label="URI"
                help="Optional canonical link (Confluence, design doc URL, …)."
              >
                <TextInput
                  value={draft.uri}
                  onChange={(v) => setDraft((d) => ({ ...d, uri: v }))}
                  placeholder="https://…"
                />
              </FormField>
            </div>

            <FormField label="Tags" help="Comma-separated.">
              <TextInput
                value={draft.tags}
                onChange={(v) => setDraft((d) => ({ ...d, tags: v }))}
                placeholder="api, auth, …"
              />
            </FormField>

            <FormField label="Body" help="Markdown. Long-form is fine.">
              <div className="overflow-hidden rounded-xl border border-border bg-bg">
                <MarkdownEditor
                  value={draft.body_md}
                  onChange={(v) => setDraft((d) => ({ ...d, body_md: v }))}
                  height="420px"
                  lineWrapping
                  lineNumbers
                  placeholder="Paste or write the source document here…"
                />
              </div>
            </FormField>
          </section>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {mode === "edit" && (
              <button
                type="button"
                onClick={() => setDraft(initialDraft)}
                disabled={!dirty || readOnly}
                className={cn(outlineButtonClass, "py-1.5 text-xs")}
              >
                Reset
              </button>
            )}
            {mode === "edit" && (
              <button
                type="button"
                onClick={() => void onDelete()}
                disabled={readOnly || deleting}
                className={dangerButtonClass}
              >
                <Trash2 className="h-4 w-4" />
                {deleting ? "Deleting…" : "Delete"}
              </button>
            )}
            <button
              type="button"
              onClick={() => void save()}
              disabled={readOnly || saving || Boolean(titleError) || (mode === "edit" && !dirty)}
              className={primaryButtonClass}
            >
              <Save className="h-4 w-4" />
              {saving ? "Saving…" : mode === "create" ? "Create" : "Save changes"}
              <span className="ml-1 hidden font-mono text-[10px] opacity-70 sm:inline">⌘S</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
