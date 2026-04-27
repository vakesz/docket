"use client";

import type { ItemKind, StateBucket } from "@/core/types";
import { metaLabelFaintClass } from "@/lib/form-classes";
import { displayTag, formatKind } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CreateItemForm } from "@/ui/items/create-item-form";

export type FilterState = {
  bucket: StateBucket;
  showArchived: boolean;
  kind: ItemKind | "all";
  activeTag: string | null;
  query: string;
  tagsExpanded: boolean;
};

export type FilterHandlers = {
  setBucket: (b: StateBucket) => void;
  setShowArchived: (b: boolean) => void;
  setKind: (k: ItemKind | "all") => void;
  setActiveTag: (t: string | null) => void;
  setQuery: (q: string) => void;
  setTagsExpanded: (fn: (v: boolean) => boolean) => void;
};

export function FilterBar({
  projectId,
  state,
  handlers,
  visibleKinds,
  tagCounts,
  tagCollapseLimit,
}: {
  projectId: string;
  state: FilterState;
  handlers: FilterHandlers;
  visibleKinds: Array<ItemKind | "all">;
  tagCounts: Array<[string, number]>;
  tagCollapseLimit: number;
}) {
  const { bucket, showArchived, kind, activeTag, query, tagsExpanded } = state;
  return (
    <div className="flex flex-col gap-2 border-b border-border p-3">
      <div className="flex items-center gap-2">
        <input
          type="search"
          placeholder="Filter by title, id, tag…"
          value={query}
          onChange={(e) => handlers.setQuery(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
        />
        <CreateItemForm projectId={projectId} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {visibleKinds.length > 2 &&
          visibleKinds.map((k) => (
            <button
              type="button"
              key={k}
              onClick={() => handlers.setKind(k)}
              className={cn(
                "rounded-md px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
                kind === k ? "bg-fg text-bg" : "text-fg-muted hover:bg-surface-alt",
              )}
            >
              {k === "all" ? "All" : formatKind(k)}
            </button>
          ))}
        <label
          className={cn(
            "flex items-center gap-1",
            metaLabelFaintClass,
            visibleKinds.length > 2 && "ml-auto",
          )}
        >
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => handlers.setShowArchived(e.target.checked)}
            className="accent-accent"
          />
          Archived
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {(["open", "closed", "all"] as StateBucket[]).map((b) => (
          <button
            type="button"
            key={b}
            onClick={() => handlers.setBucket(b)}
            className={cn(
              "rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
              bucket === b ? "bg-accent text-accent-fg" : "text-fg-muted hover:bg-surface-alt",
            )}
            title={
              b === "open"
                ? "new, active, blocked, needs info"
                : b === "closed"
                  ? "resolved, closed"
                  : "every state"
            }
          >
            {b === "open" ? "Open" : b === "closed" ? "Closed" : "All states"}
          </button>
        ))}
      </div>
      {tagCounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => handlers.setActiveTag(null)}
            className={cn(
              "rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
              activeTag === null ? "bg-fg text-bg" : "text-fg-faint hover:bg-surface-alt",
            )}
          >
            Any tag
          </button>
          {(tagsExpanded ? tagCounts : tagCounts.slice(0, tagCollapseLimit)).map(([t, n]) => {
            const label = displayTag(t);
            const selected = activeTag === t;
            return (
              <button
                type="button"
                key={t}
                onClick={() => handlers.setActiveTag(selected ? null : t)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] lowercase tracking-wide transition-colors",
                  selected
                    ? "bg-accent text-accent-fg"
                    : "bg-surface-alt text-fg-muted hover:bg-surface",
                )}
                title={`${t} — ${n} item${n === 1 ? "" : "s"}`}
              >
                <span>{label}</span>
                <span
                  className={cn(
                    "text-[9px] tabular-nums",
                    selected ? "text-accent-fg/75" : "text-fg-faint",
                  )}
                >
                  {n}
                </span>
              </button>
            );
          })}
          {tagCounts.length > tagCollapseLimit && (
            <button
              type="button"
              onClick={() => handlers.setTagsExpanded((v) => !v)}
              className="rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-faint hover:bg-surface-alt"
            >
              {tagsExpanded ? "Show less" : `+${tagCounts.length - tagCollapseLimit} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
