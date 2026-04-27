"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import type { ItemKind, StateBucket } from "@/core/types";
import { metaLabelFaintClass } from "@/lib/form-classes";
import { displayTag, formatKind } from "@/lib/format";
import { freshnessTone } from "@/lib/staleness";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
import { CreateItemForm } from "@/ui/items/create-item-form";
import { FreshnessStamp } from "@/ui/items/freshness";
import { StatePill } from "@/ui/items/state-pill";

const KINDS: Array<ItemKind | "all"> = ["all", "epic", "feature", "story", "task", "bug"];

/**
 * Left pane of the workspace shell: search + filter chips on top of the
 * cached item list, with pinned items pulled out into their own section
 * above. Rows are plain links to `/items/[id]` so detail navigation reuses
 * the surrounding layout (this pane stays mounted across detail clicks).
 *
 * Filters split server-side vs client-side by who pays for them:
 * - `bucket` and `archived` reshape the server query (sent through tRPC).
 * - `kind`, `tag`, and search live in component state and just decide
 *   which already-fetched rows render.
 *
 * TODO(port): bring back virtualization (`@tanstack/react-virtual` on
 * main) once the list grows past a few hundred rows in practice.
 */
export function BacklogPane({
  projectId,
  staleThresholdDays,
}: {
  projectId: string;
  staleThresholdDays: number | null;
}) {
  const [bucket, setBucket] = useState<StateBucket>("open");
  const [showArchived, setShowArchived] = useState(false);
  const [kind, setKind] = useState<ItemKind | "all">("all");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tagsExpanded, setTagsExpanded] = useState(false);

  const items = trpc.items.list.useQuery(
    { projectId, bucket, archived: showArchived, limit: 200 },
    { staleTime: 30_000 },
  );
  const pinned = trpc.watchlist.list.useQuery({ projectId, limit: 50 }, { staleTime: 30_000 });
  const settings = trpc.settings.list.useQuery(undefined, { staleTime: 60_000 });
  const maxVisibleTags = (() => {
    const raw = settings.data?.find((r) => r.key === "items.max-visible-tags")?.value;
    return typeof raw === "number" ? raw : 2;
  })();

  const pathname = usePathname();
  const selectedId = useMemo(() => {
    const m = pathname?.match(/\/items\/([^/?#]+)/);
    return m?.[1];
  }, [pathname]);

  const pinnedIds = useMemo(
    () => new Set((pinned.data ?? []).map((p) => p.item.id)),
    [pinned.data],
  );

  const data = items.data ?? [];

  const kindCounts = useMemo(() => {
    const counts = new Map<ItemKind, number>();
    for (const it of data)
      counts.set(it.kind as ItemKind, (counts.get(it.kind as ItemKind) ?? 0) + 1);
    return counts;
  }, [data]);

  const visibleKinds = useMemo(() => {
    const available = KINDS.filter((k) => k === "all" || (kindCounts.get(k) ?? 0) > 0);
    if (kind !== "all" && !available.includes(kind)) available.push(kind);
    return available;
  }, [kindCounts, kind]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of data) {
      for (const t of it.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.filter((it) => {
      if (kind !== "all" && it.kind !== kind) return false;
      if (activeTag && !(it.tags ?? []).includes(activeTag)) return false;
      if (q) {
        const hay = `${it.providerItemId} ${it.title} ${(it.tags ?? []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data, kind, activeTag, query]);

  const tagCollapseLimit = maxVisibleTags;

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <input
            type="search"
            placeholder="Filter by title, id, tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
                onClick={() => setKind(k)}
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
              onChange={(e) => setShowArchived(e.target.checked)}
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
              onClick={() => setBucket(b)}
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
              onClick={() => setActiveTag(null)}
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
                  onClick={() => setActiveTag(selected ? null : t)}
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
                onClick={() => setTagsExpanded((v) => !v)}
                className="rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-faint hover:bg-surface-alt"
              >
                {tagsExpanded ? "Show less" : `+${tagCounts.length - tagCollapseLimit} more`}
              </button>
            )}
          </div>
        )}
      </div>

      {pinned.data && pinned.data.length > 0 && (
        <div className="border-b border-border bg-surface">
          <div className={cn("flex items-center gap-2 px-3 pt-2 pb-1", metaLabelFaintClass)}>
            <span className="text-accent">●</span>
            <span>Pinned</span>
            <span className="text-fg-faint">{pinned.data.length}</span>
          </div>
          {pinned.data.map(({ item: it }) => (
            <PinnedRow
              key={`pinned-${it.id}`}
              projectId={projectId}
              item={it}
              selected={selectedId === it.id}
            />
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {items.isPending ? (
          <EmptyMessage text="Loading…" />
        ) : items.error ? (
          <EmptyMessage text={items.error.message} tone="error" />
        ) : filtered.length === 0 ? (
          <EmptyMessage text="No items in this view." />
        ) : (
          filtered.map((it) => (
            <ItemRow
              key={it.id}
              projectId={projectId}
              item={it}
              pinned={pinnedIds.has(it.id)}
              selected={selectedId === it.id}
              staleThresholdDays={staleThresholdDays}
              maxVisibleTags={maxVisibleTags}
            />
          ))
        )}
      </div>
    </div>
  );
}

type ListItem = {
  id: string;
  providerItemId: string;
  kind: string;
  title: string;
  state: string;
  assignee: string | null;
  tags: string[];
  url: string | null;
  updatedAt: Date;
};

function ItemRow({
  projectId,
  item,
  pinned,
  selected,
  staleThresholdDays,
  maxVisibleTags,
}: {
  projectId: string;
  item: ListItem;
  pinned: boolean;
  selected: boolean;
  staleThresholdDays: number | null;
  maxVisibleTags: number;
}) {
  const tags = item.tags ?? [];
  const shownTags = tags.slice(0, maxVisibleTags);
  const extraTags = tags.length - shownTags.length;
  const hasMeta = Boolean(item.assignee) || tags.length > 0;
  const tone = freshnessTone(item.updatedAt, staleThresholdDays);

  return (
    <Link
      href={`/projects/${projectId}/items/${item.id}`}
      className={cn(
        "flex w-full flex-col gap-1 border-b border-border px-3 py-2 text-left transition-colors",
        "hover:bg-surface-alt",
        selected && "bg-surface-alt",
        tone === "warning" && "bg-warning-bg/40 hover:bg-warning-bg/70",
        tone === "stale" && "bg-danger-bg/40 hover:bg-danger-bg/70",
      )}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className={metaLabelFaintClass}>{formatKind(item.kind)}</span>
        <StatePill state={item.state} />
        {pinned && (
          <span className="font-mono text-[10px] text-accent" title="Pinned">
            ●
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-fg-faint">
          <FreshnessStamp updatedAt={item.updatedAt} thresholdDays={staleThresholdDays} />
          <span>{item.providerItemId}</span>
        </span>
      </div>
      <div className="line-clamp-2 text-sm text-fg">{item.title}</div>
      {hasMeta && (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-fg-faint">
          {item.assignee && <span className="truncate">{item.assignee}</span>}
          {item.assignee && tags.length > 0 && (
            <span aria-hidden className="text-fg-faint">
              ·
            </span>
          )}
          {shownTags.map((t) => (
            <span key={t} title={t} className="rounded bg-surface-alt px-1.5 py-0.5 text-fg-muted">
              {displayTag(t)}
            </span>
          ))}
          {extraTags > 0 && <span className="text-fg-faint">+{extraTags}</span>}
        </div>
      )}
    </Link>
  );
}

function PinnedRow({
  projectId,
  item,
  selected,
}: {
  projectId: string;
  item: { id: string; providerItemId: string; title: string; state: string; kind: string };
  selected: boolean;
}) {
  return (
    <Link
      href={`/projects/${projectId}/items/${item.id}`}
      className={cn(
        "flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs transition-colors",
        "hover:bg-surface-alt",
        selected && "bg-surface-alt",
      )}
    >
      <span className={metaLabelFaintClass}>{formatKind(item.kind)}</span>
      <StatePill state={item.state} />
      <span className="flex-1 truncate text-fg">{item.title}</span>
      <span className="font-mono text-[10px] text-fg-faint">{item.providerItemId}</span>
    </Link>
  );
}

function EmptyMessage({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <div
      className={cn(
        "flex h-full items-center justify-center p-6 text-center text-sm",
        tone === "error" ? "text-danger" : "text-fg-faint",
      )}
    >
      {text}
    </div>
  );
}
