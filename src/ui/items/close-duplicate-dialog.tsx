"use client";

import { Search } from "lucide-react";
import { useState } from "react";
import { formatState } from "@/lib/format";
import { trpc } from "@/lib/trpc-client";
import { Badge } from "@/ui/primitives/badge";
import { Button } from "@/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/primitives/dialog";
import { Input } from "@/ui/primitives/input";

/**
 * Picker shown before staging a `close_duplicate` proposal — asks "what is
 * this a duplicate of?" so the executor has a canonical item to name in the
 * paired comment. Without this step, the close transition lands but the
 * duplicate-link is invisible (neither GitHub nor AzDO has a native
 * "duplicate" reason; the comment body is the durable record).
 */
export function CloseDuplicateDialog({
  projectSlug,
  sourceProviderItemId,
  open,
  onOpenChange,
  onSelect,
}: {
  projectSlug: string;
  sourceProviderItemId: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onSelect: (canonicalItemId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const results = trpc.items.search.useQuery(
    { projectSlug, q: trimmed, limit: 20 },
    { enabled: open && trimmed.length > 0, staleTime: 30_000 },
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Mark as duplicate of…</DialogTitle>
          <DialogDescription>
            Pick the canonical item this one duplicates. The close will be paired with a comment
            naming it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="relative">
            <Search className="absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title or id…"
              className="pl-7"
            />
          </div>

          <div className="min-h-[6rem]">
            {trimmed.length === 0 ? (
              <p className="text-muted-foreground text-sm">Start typing to search this project.</p>
            ) : results.isPending ? (
              <p className="text-muted-foreground text-sm">Searching…</p>
            ) : results.error ? (
              <p className="text-destructive text-sm">Search failed: {results.error.message}</p>
            ) : results.data && results.data.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {results.data
                  .filter((row) => row.providerItemId !== sourceProviderItemId)
                  .map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(row.providerItemId);
                          onOpenChange(false);
                          setQuery("");
                        }}
                        className="flex w-full min-w-0 flex-col gap-0.5 rounded border border-border px-3 py-2 text-left hover:bg-muted"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium">{row.title}</span>
                          <Badge variant="secondary" className="shrink-0 text-[10px] uppercase">
                            {formatState(row.state)}
                          </Badge>
                        </span>
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                          {row.itemNumber}
                        </span>
                      </button>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">No matches.</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
