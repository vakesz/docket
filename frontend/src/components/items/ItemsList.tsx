import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import type { DTO } from "~/api/client";
import { useItems, usePinned, useSettings } from "~/api/hooks";
import { FreshnessStamp, useStaleThreshold } from "~/components/items/ItemFreshness";
import { cn } from "~/lib/cn";
import { displayTag, formatKind, formatState } from "~/lib/format";
import { freshnessTone } from "~/lib/staleness";

type Item = DTO["ItemDTO"];
type ItemKind = DTO["ItemKind"];
type ItemState = DTO["ItemState"];

const KINDS: Array<ItemKind | "all"> = ["all", "epic", "feature", "story", "task", "bug"];

type StateBucket = "open" | "done" | "all";

// "Open" collapses the triage-relevant states; "Done" is the terminal set the
// user usually wants to hide. Keep the backend enum literals as the source of
// truth — rename here if core/model.py ever grows a new state.
const STATE_BUCKETS: Record<StateBucket, ItemState[] | null> = {
  open: ["new", "active", "blocked", "needs_info"],
  done: ["resolved", "closed"],
  all: null,
};

interface Props {
  selectedId: string | undefined;
}

export function ItemsList({ selectedId }: Props) {
  const [kind, setKind] = useState<ItemKind | "all">("all");
  const [stateBucket, setStateBucket] = useState<StateBucket>("open");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [tagsExpanded, setTagsExpanded] = useState(false);

  const settings = useSettings();
  const staleThresholdDays = useStaleThreshold();
  // `ui.tag_filter_collapse_limit` in config.toml; 0 means "never collapse".
  const tagCollapseLimit = readTagCollapseLimit(settings.data?.config);

  const items = useItems({
    kind: kind === "all" ? undefined : kind,
    state: STATE_BUCKETS[stateBucket] ?? undefined,
    tag: activeTag ?? undefined,
    archived: showArchived,
  });
  // Unfiltered-by-kind query so the kind chip bar can adapt to the provider:
  // Azure DevOps surfaces all five kinds; GitHub issues currently only map to
  // `task`, so there's no point showing Epic/Feature/Story/Bug there. Counts
  // come from the same state bucket and archived flag so the chip bar matches
  // what the user would see after clicking.
  const itemsForKinds = useItems({
    state: STATE_BUCKETS[stateBucket] ?? undefined,
    archived: showArchived,
  });
  const pinned = usePinned();

  const navigate = useNavigate();
  const parentRef = useRef<HTMLDivElement>(null);

  const pinnedIds = useMemo(() => new Set((pinned.data ?? []).map((p) => p.id)), [pinned.data]);

  const kindCounts = useMemo(() => {
    const counts = new Map<ItemKind, number>();
    for (const it of itemsForKinds.data ?? []) {
      counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
    }
    return counts;
  }, [itemsForKinds.data]);

  // Only advertise kinds the active provider actually produces. Always keep
  // the currently-selected kind visible so it doesn't vanish mid-interaction.
  const visibleKinds = useMemo(() => {
    const available = KINDS.filter((k) => k === "all" || (kindCounts.get(k) ?? 0) > 0);
    if (kind !== "all" && !available.includes(kind)) available.push(kind);
    return available;
  }, [kindCounts, kind]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items.data ?? []) {
      for (const t of it.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [items.data]);

  const filtered = useMemo(() => {
    if (!items.data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return items.data;
    return items.data.filter((it) => {
      const haystack = `${it.id} ${it.title} ${(it.tags ?? []).join(" ")}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [items.data, query]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    // Rows grow with 2-line titles, assignee, and tag pills, so the 58px
    // estimate was a floor, not a ceiling — fixed-height slots caused rows
    // to visually overlap. `measureElement` lets the virtualizer read each
    // row's actual height after it renders and lay them out without gaps
    // or overlap.
    estimateSize: () => 58,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 8,
  });

  return (
    <div className="flex h-full flex-col bg-white dark:bg-zinc-950">
      <div className="flex flex-col gap-2 border-b border-zinc-200 p-2 dark:border-zinc-800">
        <input
          type="search"
          placeholder="Filter by title, id, tag…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded border border-zinc-200 bg-white px-2 py-1 text-sm focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
        />
        <div className="flex flex-wrap items-center gap-1">
          {visibleKinds.length > 2 &&
            visibleKinds.map((k) => (
              <button
                type="button"
                key={k}
                onClick={() => setKind(k)}
                className={cn(
                  "rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                  kind === k
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900",
                )}
              >
                {k === "all" ? "All" : formatKind(k)}
              </button>
            ))}
          <label
            className={cn(
              "flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500",
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
          {(["open", "done", "all"] as StateBucket[]).map((b) => (
            <button
              type="button"
              key={b}
              onClick={() => setStateBucket(b)}
              className={cn(
                "rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                stateBucket === b
                  ? "bg-accent text-white"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900",
              )}
              title={
                b === "open"
                  ? "new, active, blocked, needs info"
                  : b === "done"
                    ? "resolved, closed"
                    : "every state"
              }
            >
              {b === "open" ? "Open" : b === "done" ? "Done" : "All states"}
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
                activeTag === null
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-500 dark:hover:bg-zinc-900",
              )}
            >
              Any tag
            </button>
            {(tagCollapseLimit <= 0 || tagsExpanded
              ? tagCounts
              : tagCounts.slice(0, tagCollapseLimit)
            ).map(([t, n]) => {
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
                      ? "bg-accent text-white"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800",
                  )}
                  title={`${t} — ${n} item${n === 1 ? "" : "s"}`}
                >
                  <span>{label}</span>
                  <span
                    className={cn(
                      "text-[9px] tabular-nums",
                      selected ? "text-white/75" : "text-zinc-400 dark:text-zinc-500",
                    )}
                  >
                    {n}
                  </span>
                </button>
              );
            })}
            {tagCollapseLimit > 0 && tagCounts.length > tagCollapseLimit && (
              <button
                type="button"
                onClick={() => setTagsExpanded((v) => !v)}
                className="rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
              >
                {tagsExpanded ? "Show less" : `+${tagCounts.length - tagCollapseLimit} more`}
              </button>
            )}
          </div>
        )}
      </div>

      <div ref={parentRef} className="flex-1 overflow-auto">
        {items.isPending ? (
          <EmptyMessage text="Loading…" />
        ) : items.error ? (
          <EmptyMessage text={items.error.message} tone="error" />
        ) : filtered.length === 0 ? (
          <EmptyMessage text="No items in this view." />
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const it = filtered[virtualRow.index];
              if (!it) return null;
              return (
                <div
                  key={it.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <ItemRow
                    item={it}
                    pinned={pinnedIds.has(it.id)}
                    selected={selectedId === it.id}
                    staleThresholdDays={staleThresholdDays}
                    onClick={() =>
                      navigate({
                        to: "/items/$itemId",
                        params: { itemId: it.id },
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ItemRow({
  item,
  pinned,
  selected,
  staleThresholdDays,
  onClick,
}: {
  item: Item;
  pinned: boolean;
  selected: boolean;
  staleThresholdDays: number | null;
  onClick: () => void;
}) {
  const tags = item.tags ?? [];
  const shownTags = tags.slice(0, 2);
  const extraTags = tags.length - shownTags.length;
  const hasMeta = Boolean(item.assignee) || tags.length > 0;
  const tone = freshnessTone(item.updated_at, staleThresholdDays);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full flex-col gap-1 border-b border-zinc-100 px-3 py-2 text-left transition-colors",
        "hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900",
        selected && "bg-zinc-100 dark:bg-zinc-900",
        tone === "warning" &&
          "bg-amber-50/40 hover:bg-amber-50/70 dark:bg-amber-950/10 dark:hover:bg-amber-950/20",
        tone === "stale" &&
          "bg-rose-50/40 hover:bg-rose-50/70 dark:bg-rose-950/10 dark:hover:bg-rose-950/20",
      )}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          {formatKind(item.kind)}
        </span>
        <StatePill state={item.state} />
        {pinned && (
          <span className="font-mono text-[10px] text-accent" title="Pinned">
            ●
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-zinc-400">
          {item.updated_at && (
            <FreshnessStamp updatedAt={item.updated_at} thresholdDays={staleThresholdDays} />
          )}
          <span>#{item.id}</span>
        </span>
      </div>
      <div className="line-clamp-2 text-sm text-zinc-900 dark:text-zinc-100">{item.title}</div>
      {hasMeta && (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-zinc-500">
          {item.assignee && <span className="truncate">{item.assignee}</span>}
          {item.assignee && tags.length > 0 && (
            <span aria-hidden className="text-zinc-300 dark:text-zinc-700">
              ·
            </span>
          )}
          {shownTags.map((t) => (
            <span
              key={t}
              title={t}
              className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
            >
              {displayTag(t)}
            </span>
          ))}
          {extraTags > 0 && <span className="text-zinc-400 dark:text-zinc-600">+{extraTags}</span>}
        </div>
      )}
    </button>
  );
}

function readTagCollapseLimit(config: Record<string, unknown> | undefined): number {
  if (!config) return 4;
  const ui = config.ui;
  if (!ui || typeof ui !== "object") return 4;
  const raw = (ui as Record<string, unknown>).tag_filter_collapse_limit;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 4;
}

const STATE_TONE: Record<string, string> = {
  new: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  active: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  blocked: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  needs_info: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  resolved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  closed: "bg-zinc-200 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-500",
};

export function StatePill({ state }: { state: string }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
        STATE_TONE[state] ?? STATE_TONE.new,
      )}
    >
      {formatState(state)}
    </span>
  );
}

function EmptyMessage({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <div
      className={cn(
        "flex h-full items-center justify-center p-6 text-center text-sm",
        tone === "error" ? "text-rose-600 dark:text-rose-400" : "text-zinc-500",
      )}
    >
      {text}
    </div>
  );
}
