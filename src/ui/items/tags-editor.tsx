"use client";

import { Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { displayTag } from "@/lib/format";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/primitives/popover";

const MAX_TAG_LEN = 80;
const MAX_TAGS = 50;

/**
 * Inline tag editor that replaces the read-only chip row in the item detail
 * header. Builds a local draft (chips render with add/remove decoration) and
 * stages a single `tags_change` proposal on Save. UI-origin tag changes are
 * on the auto-accept floor (`AUTO_ACCEPT_FLOOR_KINDS` in
 * `src/server/settings/catalog.ts`), so the cache refresh fires immediately
 * unless the system is in read-only mode.
 *
 * `stateEncodingTags` lists the lowercased tags the provider uses to encode
 * canonical state — those chips render as muted, non-removable. The editor
 * never includes them in `nextTags`, and the provider's `setTags` re-unions
 * them in regardless, so the diff stays honest.
 */
export function TagsEditor({
  projectSlug,
  providerItemId,
  currentTags,
  stateEncodingTags,
}: {
  projectSlug: string;
  providerItemId: string;
  currentTags: readonly string[];
  stateEncodingTags: readonly string[];
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const inputId = useId();

  const reservedSet = new Set(stateEncodingTags.map((t) => t.toLowerCase()));
  const reservedFromCurrent = currentTags.filter((t) => reservedSet.has(t.toLowerCase()));
  const editableInitial = currentTags.filter((t) => !reservedSet.has(t.toLowerCase()));

  const [draft, setDraft] = useState<readonly string[]>(editableInitial);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Re-baseline whenever the item's tags change (sync, refresh, or the proposal
  // landed and `router.refresh()` brought new props down).
  // biome-ignore lint/correctness/useExhaustiveDependencies: editableInitial is recomputed every render; depend on the source array.
  useEffect(() => {
    setDraft(editableInitial);
    setError(null);
  }, [currentTags, stateEncodingTags]);

  const draftSetLower = new Set(draft.map((t) => t.toLowerCase()));
  const initialSetLower = new Set(editableInitial.map((t) => t.toLowerCase()));

  const added = draft.filter((t) => !initialSetLower.has(t.toLowerCase()));
  const removed = editableInitial.filter((t) => !draftSetLower.has(t.toLowerCase()));
  const dirty = added.length > 0 || removed.length > 0;

  const projectTagsQuery = trpc.items.listProjectTags.useQuery(
    { projectSlug },
    { enabled: pickerOpen, staleTime: 60_000 },
  );

  const propose = trpc.proposals.proposeTagsChange.useMutation({
    onSuccess: async (res) => {
      setError(null);
      if (res.status === "confirmed") {
        await Promise.all([
          utils.items.get.invalidate(),
          utils.items.list.invalidate(),
          utils.items.listProjectTags.invalidate({ projectSlug }),
        ]);
        router.refresh();
        return;
      }
      // Read-only mode (or any other reason the floor didn't auto-accept):
      // surface a hint; the proposal is still pending and an approver can
      // confirm it from the proposals surface.
      setError("Saved as a pending proposal — read-only mode is on.");
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const trimmed = query.trim();
  const trimmedLower = trimmed.toLowerCase();
  const isReservedQuery = reservedSet.has(trimmedLower);
  const projectSuggestions = (projectTagsQuery.data ?? []).filter((tag) => {
    const lower = tag.toLowerCase();
    if (draftSetLower.has(lower)) return false;
    if (reservedSet.has(lower)) return false;
    if (!trimmedLower) return true;
    return lower.includes(trimmedLower);
  });

  const exactMatch =
    trimmedLower.length > 0 && draftSetLower.has(trimmedLower)
      ? false
      : projectSuggestions.some((t) => t.toLowerCase() === trimmedLower);
  const canCreate =
    trimmed.length > 0 &&
    trimmed.length <= MAX_TAG_LEN &&
    !isReservedQuery &&
    !draftSetLower.has(trimmedLower) &&
    !exactMatch;

  function addTag(raw: string) {
    const t = raw.trim();
    if (!t) return;
    if (t.length > MAX_TAG_LEN) {
      setError(`Tags can be at most ${MAX_TAG_LEN} characters.`);
      return;
    }
    if (reservedSet.has(t.toLowerCase())) return;
    if (draftSetLower.has(t.toLowerCase())) return;
    if (draft.length >= MAX_TAGS) {
      setError(`At most ${MAX_TAGS} tags per item.`);
      return;
    }
    setDraft([...draft, t]);
    setQuery("");
    setError(null);
    inputRef.current?.focus();
  }

  function removeTag(tag: string) {
    setDraft(draft.filter((t) => t.toLowerCase() !== tag.toLowerCase()));
    setError(null);
  }

  function cancel() {
    setDraft(editableInitial);
    setQuery("");
    setError(null);
    setPickerOpen(false);
  }

  function save() {
    const next = [...reservedFromCurrent, ...draft];
    propose.mutate({ projectSlug, providerItemId, nextTags: next });
  }

  const busy = propose.isPending;

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {reservedFromCurrent.map((tag) => (
        <span
          key={`reserved:${tag}`}
          title={`${tag} (managed by transitions)`}
          className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70 italic"
        >
          {displayTag(tag)}
        </span>
      ))}
      {draft.map((tag) => {
        const isAdded = !initialSetLower.has(tag.toLowerCase());
        return (
          <span
            key={`draft:${tag}`}
            title={tag}
            className={cn(
              "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-mono text-[10px]",
              isAdded
                ? "bg-primary/10 text-primary ring-1 ring-primary/30"
                : "bg-muted text-muted-foreground",
            )}
          >
            <span>{displayTag(tag)}</span>
            <button
              type="button"
              onClick={() => removeTag(tag)}
              disabled={busy}
              aria-label={`Remove ${tag}`}
              className="ml-0.5 inline-flex size-3 items-center justify-center rounded-sm hover:bg-foreground/10 disabled:opacity-50"
            >
              <X className="size-2.5" />
            </button>
          </span>
        );
      })}
      {removed.map((tag) => (
        <span
          key={`removed:${tag}`}
          title={`${tag} (will be removed)`}
          className="inline-flex items-center gap-0.5 rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-[10px] text-destructive line-through"
        >
          <span>{displayTag(tag)}</span>
          <button
            type="button"
            onClick={() => addTag(tag)}
            disabled={busy}
            aria-label={`Restore ${tag}`}
            className="ml-0.5 inline-flex size-3 items-center justify-center rounded-sm no-underline hover:bg-foreground/10 disabled:opacity-50"
          >
            <Plus className="size-2.5" />
          </button>
        </span>
      ))}

      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={busy}
            aria-label="Add tag"
            className="inline-flex items-center gap-0.5 rounded border border-border border-dashed px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            <Plus className="size-2.5" />
            <span>tag</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-64 gap-2 p-2"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <Input
            id={inputId}
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find or create…"
            className="h-7 text-xs"
            maxLength={MAX_TAG_LEN}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (canCreate) addTag(trimmed);
                else if (projectSuggestions.length > 0) addTag(projectSuggestions[0] as string);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setPickerOpen(false);
              }
            }}
          />
          <div className="max-h-48 overflow-auto">
            {projectTagsQuery.isPending ? (
              <p className="px-1 py-1 text-muted-foreground text-xs">Loading…</p>
            ) : projectSuggestions.length === 0 && !canCreate ? (
              <p className="px-1 py-1 text-muted-foreground text-xs">
                {trimmed.length === 0
                  ? "No tags in this project yet."
                  : isReservedQuery
                    ? "Reserved by the provider."
                    : "No matches."}
              </p>
            ) : (
              <ul className="flex flex-col">
                {projectSuggestions.slice(0, 50).map((tag) => (
                  <li key={tag}>
                    <button
                      type="button"
                      onClick={() => addTag(tag)}
                      className="w-full truncate rounded px-1.5 py-1 text-left font-mono text-xs hover:bg-muted"
                    >
                      {displayTag(tag)}
                    </button>
                  </li>
                ))}
                {canCreate ? (
                  <li>
                    <button
                      type="button"
                      onClick={() => addTag(trimmed)}
                      className="w-full truncate rounded px-1.5 py-1 text-left text-xs hover:bg-muted"
                    >
                      <span className="text-muted-foreground">Create </span>
                      <span className="font-mono">"{trimmed}"</span>
                    </button>
                  </li>
                ) : null}
              </ul>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {dirty ? (
        <span className="ml-1 inline-flex items-center gap-1">
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={cancel}>
            Cancel
          </Button>
          <Button type="button" size="xs" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </span>
      ) : null}

      {error ? <span className="ml-1 text-[10px] text-destructive">{error}</span> : null}
    </span>
  );
}
