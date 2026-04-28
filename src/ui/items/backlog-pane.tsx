"use client";

import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { BacklogBucket, ItemKind } from "@/core/types";
import { metaLabelFaintClass } from "@/lib/form-classes";
import { useRecentItemIds } from "@/lib/recent-items";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
import { ASSIGNEE_UNASSIGNED, FilterBar } from "@/ui/items/filter-bar";
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
 * - `bucket` reshapes the server query (sent through tRPC). It encodes
 *   open/closed/archived/all as a single axis; the router maps it onto a
 *   state-bucket + archived-flag pair.
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
  const [bucket, setBucket] = useState<BacklogBucket>("open");
  const [kind, setKind] = useState<ItemKind | "all">("all");
  const [activeTags, setActiveTags] = useState<ReadonlySet<string>>(new Set());
  const [activeAssignees, setActiveAssignees] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [assigneesExpanded, setAssigneesExpanded] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  const items = trpc.items.list.useQuery(
    { projectId, bucket, limit: ITEMS_QUERY_LIMIT },
    { staleTime: 30_000 },
  );
  const pinned = trpc.watchlist.list.useQuery(
    { projectId, limit: PINNED_QUERY_LIMIT },
    { staleTime: 30_000 },
  );
  const settings = trpc.settings.list.useQuery(undefined, { staleTime: 60_000 });
  const me = trpc.projects.me.useQuery(undefined, { staleTime: 5 * 60_000 });
  const meIdentifier = me.data?.name ?? null;
  const maxVisibleTags = (() => {
    const raw = settings.data?.find((r) => r.key === "items.max-visible-tags")?.value;
    return typeof raw === "number" ? raw : 2;
  })();
  const maxVisibleAssignees = (() => {
    const raw = settings.data?.find((r) => r.key === "items.max-visible-assignees")?.value;
    return typeof raw === "number" ? raw : 2;
  })();
  const assigneeSelectorStyle: "chips" | "dropdown" = (() => {
    const raw = settings.data?.find((r) => r.key === "items.assignee-selector-style")?.value;
    return raw === "dropdown" ? "dropdown" : "chips";
  })();
  const showAvatars = (() => {
    const raw = settings.data?.find((r) => r.key === "items.show-assignee-avatars")?.value;
    return typeof raw === "boolean" ? raw : true;
  })();
  const showArchivedBucket = (() => {
    const raw = settings.data?.find((r) => r.key === "items.show-archived-bucket")?.value;
    return typeof raw === "boolean" ? raw : true;
  })();
  const project = trpc.projects.get.useQuery({ projectId }, { staleTime: 5 * 60_000 });
  const providerKind = project.data?.providerKind ?? "";
  const providerHasAvatars = project.data?.hasAvatarFetcher ?? false;

  // If the user disabled the archived bucket while it was selected, fall
  // back to open so the request and the (now-hidden) chip don't desync.
  useEffect(() => {
    if (!showArchivedBucket && bucket === "archived") setBucket("open");
  }, [showArchivedBucket, bucket]);

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

  // One pass over `data` produces all three facet aggregates. Keeping the
  // counts in a single memo (vs the previous four) avoids two redundant
  // walks per render and one Map allocation. `kind` is only here to fold
  // the active selection into `visibleKinds` when it's filtered out by zero
  // count — the underlying tallies don't depend on it.
  const facets = useMemo(() => {
    const kindMap = new Map<ItemKind, number>();
    const tagMap = new Map<string, number>();
    const assigneeMap = new Map<string, number>();
    for (const it of data) {
      const k = it.kind as ItemKind;
      kindMap.set(k, (kindMap.get(k) ?? 0) + 1);
      for (const t of it.tags ?? []) tagMap.set(t, (tagMap.get(t) ?? 0) + 1);
      const a = it.assignee;
      if (a) assigneeMap.set(a, (assigneeMap.get(a) ?? 0) + 1);
    }
    const visibleKinds = KINDS.filter((k) => k === "all" || (kindMap.get(k) ?? 0) > 0);
    if (kind !== "all" && !visibleKinds.includes(kind)) visibleKinds.push(kind);
    const byCountThenName = (a: readonly [string, number], b: readonly [string, number]): number =>
      b[1] - a[1] || a[0].localeCompare(b[0]);
    const tagCounts = [...tagMap.entries()].sort(byCountThenName);
    const assigneeCounts = [...assigneeMap.entries()].sort(byCountThenName);
    if (meIdentifier !== null) {
      const meIdx = assigneeCounts.findIndex(([name]) => name === meIdentifier);
      if (meIdx > 0) {
        const [meEntry] = assigneeCounts.splice(meIdx, 1);
        assigneeCounts.unshift(meEntry);
      }
    }
    return { visibleKinds, tagCounts, assigneeCounts };
  }, [data, kind, meIdentifier]);
  const { visibleKinds, tagCounts, assigneeCounts } = facets;

  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    return data.filter((it) => {
      if (kind !== "all" && it.kind !== kind) return false;
      if (activeTags.size > 0) {
        const tags = it.tags ?? [];
        let matched = false;
        for (const t of activeTags) {
          if (tags.includes(t)) {
            matched = true;
            break;
          }
        }
        if (!matched) return false;
      }
      if (activeAssignees.size > 0) {
        const a = it.assignee;
        let matched = false;
        for (const sel of activeAssignees) {
          if (sel === ASSIGNEE_UNASSIGNED) {
            if (a === null || a === "") {
              matched = true;
              break;
            }
          } else if (a === sel) {
            matched = true;
            break;
          }
        }
        if (!matched) return false;
      }
      if (q) {
        const hay = `${it.providerItemId} ${it.title} ${(it.tags ?? []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data, kind, activeTags, activeAssignees, debouncedQuery]);

  return (
    <div className="flex h-full flex-col bg-bg">
      <FilterBar
        projectId={projectId}
        state={{
          bucket,
          kind,
          activeTags,
          activeAssignees,
          query,
          tagsExpanded,
          assigneesExpanded,
        }}
        handlers={{
          setBucket,
          setKind,
          setActiveTags,
          setActiveAssignees,
          setQuery,
          setTagsExpanded,
          setAssigneesExpanded,
        }}
        visibleKinds={visibleKinds}
        tagCounts={tagCounts}
        tagCollapseLimit={maxVisibleTags}
        assigneeCounts={assigneeCounts}
        assigneeCollapseLimit={maxVisibleAssignees}
        assigneeSelectorStyle={assigneeSelectorStyle}
        meIdentifier={meIdentifier}
        showArchivedBucket={showArchivedBucket}
        providerKind={providerKind}
        providerHasAvatars={providerHasAvatars}
        showAvatars={showAvatars}
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
