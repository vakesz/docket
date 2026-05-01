"use client";

import { Check, Pencil, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/primitives/popover";

const MAX_ASSIGNEE_LEN = 200;

/**
 * Inline assignee editor that replaces the read-only assignee text in the
 * item detail header. Stages a single `assignee_change` proposal on Save.
 * UI-origin assignee changes are on the auto-accept floor
 * (`AUTO_ACCEPT_FLOOR_KINDS` in `src/server/settings/catalog.ts`), so the
 * cache refresh fires immediately unless the system is in read-only mode.
 *
 * Two affordances render side-by-side:
 *   - The assignee name itself is a profile link (when the provider spec
 *     supplies a `profileUrl`) so reading flow ("who is this?") doesn't have
 *     to detour through the editor.
 *   - The pencil icon next to the name opens the popover with autocomplete,
 *     "Assign to me", and "Unassign". Editing flow ("change to who?") stays
 *     one click away.
 */
export function AssigneeEditor({
  projectSlug,
  providerItemId,
  currentAssignee,
  profileUrl,
}: {
  projectSlug: string;
  providerItemId: string;
  currentAssignee: string | null;
  profileUrl: string | null;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const inputId = useId();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setError(null);
  }, []);

  const assigneesQuery = trpc.items.listProjectAssignees.useQuery(
    { projectSlug },
    { enabled: open, staleTime: 60_000 },
  );
  const meQuery = trpc.items.currentUserIdentity.useQuery(
    { projectSlug },
    { enabled: open, staleTime: 5 * 60_000 },
  );

  const propose = trpc.proposals.proposeAssigneeChange.useMutation({
    onSuccess: async (res) => {
      setError(null);
      setOpen(false);
      setQuery("");
      if (res.status === "confirmed") {
        await Promise.all([
          utils.items.get.invalidate(),
          utils.items.list.invalidate(),
          utils.items.listProjectAssignees.invalidate({ projectSlug }),
        ]);
        router.refresh();
        return;
      }
      setError("Saved as a pending proposal — read-only mode is on.");
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  function commit(next: string | null) {
    if ((currentAssignee ?? null) === (next ?? null)) {
      setOpen(false);
      setQuery("");
      return;
    }
    propose.mutate({ projectSlug, providerItemId, nextAssignee: next });
  }

  const trimmed = query.trim();
  const trimmedLower = trimmed.toLowerCase();
  const all = assigneesQuery.data ?? [];
  const suggestions = all.filter((a) => {
    const lower = a.toLowerCase();
    if (currentAssignee && lower === currentAssignee.toLowerCase()) return false;
    if (!trimmedLower) return true;
    return lower.includes(trimmedLower);
  });
  const exactMatch =
    trimmedLower.length > 0 && suggestions.some((a) => a.toLowerCase() === trimmedLower);
  const me = meQuery.data ?? null;
  const meAlreadyCurrent = !!me && currentAssignee?.toLowerCase() === me.toLowerCase();
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_ASSIGNEE_LEN && !exactMatch;
  const busy = propose.isPending;

  return (
    <span className="inline-flex items-center gap-1">
      {currentAssignee ? (
        profileUrl ? (
          <a
            href={profileUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-foreground hover:text-primary hover:underline"
          >
            {currentAssignee}
          </a>
        ) : (
          <span className="text-foreground">{currentAssignee}</span>
        )
      ) : (
        <span className="text-muted-foreground/70 italic">unassigned</span>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={busy}
            aria-label="Edit assignee"
            className="inline-flex size-4 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <Pencil aria-hidden="true" className="size-2.5" />
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
            placeholder="Find or type an identity…"
            className="h-7 text-xs"
            maxLength={MAX_ASSIGNEE_LEN}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (canSubmit) commit(trimmed);
                else if (suggestions.length > 0) commit(suggestions[0] as string);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              }
            }}
          />
          <div className="flex flex-col gap-0.5">
            {me && !meAlreadyCurrent ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => commit(me)}
                className="flex items-center gap-1 rounded px-1.5 py-1 text-left text-xs hover:bg-muted disabled:opacity-50"
              >
                <Check className="size-3 text-primary" />
                <span>
                  Assign to me <span className="text-muted-foreground">({me})</span>
                </span>
              </button>
            ) : null}
            {currentAssignee ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => commit(null)}
                className="flex items-center gap-1 rounded px-1.5 py-1 text-left text-xs hover:bg-muted disabled:opacity-50"
              >
                <X className="size-3 text-destructive" />
                <span>Unassign</span>
              </button>
            ) : null}
          </div>
          <div className="max-h-48 overflow-auto border-border border-t pt-1">
            {assigneesQuery.isPending ? (
              <p className="px-1 py-1 text-muted-foreground text-xs">Loading…</p>
            ) : suggestions.length === 0 && !canSubmit ? (
              <p className="px-1 py-1 text-muted-foreground text-xs">
                {trimmed.length === 0 ? "No active assignees in this project yet." : "No matches."}
              </p>
            ) : (
              <ul className="flex flex-col">
                {suggestions.slice(0, 50).map((a) => (
                  <li key={a}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => commit(a)}
                      className="w-full truncate rounded px-1.5 py-1 text-left text-xs hover:bg-muted disabled:opacity-50"
                    >
                      {a}
                    </button>
                  </li>
                ))}
                {canSubmit ? (
                  <li>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => commit(trimmed)}
                      className="w-full truncate rounded px-1.5 py-1 text-left text-xs hover:bg-muted disabled:opacity-50"
                    >
                      <span className="text-muted-foreground">Assign </span>
                      <span>"{trimmed}"</span>
                    </button>
                  </li>
                ) : null}
              </ul>
            )}
          </div>
          <div className="flex items-center justify-end gap-1 border-border border-t pt-1">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Close
            </Button>
          </div>
          {error ? <p className="px-1 text-[10px] text-destructive">{error}</p> : null}
        </PopoverContent>
      </Popover>
    </span>
  );
}
