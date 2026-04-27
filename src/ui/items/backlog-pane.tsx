"use client";

import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ItemKind, StateBucket } from "@/core/types";
import { metaLabelFaintClass } from "@/lib/form-classes";
import { useRecentItemIds } from "@/lib/recent-items";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
import { FilterBar } from "@/ui/items/filter-bar";
import { EmptyMessage, ItemRow, type ListItem, PinnedRow } from "@/ui/items/item-row";

const KINDS: Array<ItemKind | "all"> = ["all", "epic", "feature", "story", "task", "bug"];

const ITEMS_QUERY_LIMIT = 200;
const PINNED_QUERY_LIMIT = 50;
const FILTER_DEBOUNCE_MS = 150;

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
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tagsExpanded, setTagsExpanded] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  const items = trpc.items.list.useQuery(
    { projectId, bucket, archived: showArchived, limit: ITEMS_QUERY_LIMIT },
    { staleTime: 30_000 },
  );
  const pinned = trpc.watchlist.list.useQuery(
    { projectId, limit: PINNED_QUERY_LIMIT },
    { staleTime: 30_000 },
  );
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

  const recentIds = useRecentItemIds(projectId);

  const data = items.data ?? [];

  const recentItems = useMemo(() => {
    if (recentIds.length === 0) return [];
    const byId = new Map(data.map((it) => [it.id, it]));
    const out: ListItem[] = [];
    for (const id of recentIds) {
      if (id === selectedId) continue;
      const it = byId.get(id);
      if (it) out.push(it);
    }
    return out;
  }, [recentIds, data, selectedId]);

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
    const q = debouncedQuery.trim().toLowerCase();
    return data.filter((it) => {
      if (kind !== "all" && it.kind !== kind) return false;
      if (activeTag && !(it.tags ?? []).includes(activeTag)) return false;
      if (q) {
        const hay = `${it.providerItemId} ${it.title} ${(it.tags ?? []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data, kind, activeTag, debouncedQuery]);

  return (
    <div className="flex h-full flex-col bg-bg">
      <FilterBar
        projectId={projectId}
        state={{ bucket, showArchived, kind, activeTag, query, tagsExpanded }}
        handlers={{
          setBucket,
          setShowArchived,
          setKind,
          setActiveTag,
          setQuery,
          setTagsExpanded,
        }}
        visibleKinds={visibleKinds}
        tagCounts={tagCounts}
        tagCollapseLimit={maxVisibleTags}
      />

      {recentItems.length > 0 && (
        <div className="border-b border-border bg-surface">
          <div className={cn("flex items-center gap-2 px-3 pt-2 pb-1", metaLabelFaintClass)}>
            <span>Recent</span>
            <span className="text-fg-faint">{recentItems.length}</span>
          </div>
          {recentItems.map((it) => (
            <PinnedRow
              key={`recent-${it.id}`}
              projectId={projectId}
              item={it}
              selected={selectedId === it.id}
            />
          ))}
        </div>
      )}

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
