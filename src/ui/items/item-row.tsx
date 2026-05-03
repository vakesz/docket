"use client";

import Link from "next/link";
import type { ItemKind, ItemState } from "@/core/types";
import { displayTag, formatKind } from "@/lib/format";
import { freshnessTone } from "@/lib/staleness";
import { cn } from "@/lib/utils";
import { FreshnessStamp } from "@/ui/items/freshness";
import { StatePill } from "@/ui/items/state-pill";

export type ListItem = {
  id: string;
  providerItemId: string;
  itemNumber: string;
  kind: ItemKind;
  title: string;
  state: ItemState;
  assignee: string | null;
  tags: string[];
  updatedAt: Date;
};

export type PinnedListItem = {
  id: string;
  providerItemId: string;
  itemNumber: string;
  title: string;
  state: ItemState;
  kind: ItemKind;
};

export function ItemRow({
  projectSlug,
  item,
  pinned,
  selected,
  staleThresholdDays,
  maxVisibleTags,
}: {
  projectSlug: string;
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
      href={`/projects/${projectSlug}/items/${item.itemNumber}`}
      // `content-visibility: auto` lets the browser skip layout / paint /
      // FreshnessStamp re-render cost for rows scrolled out of view in a long
      // backlog. `contain-intrinsic-size` provides a stable placeholder height
      // (~78px matches the 2-line title rows) so the scrollbar stays sane and
      // anchor jumps don't shift content.
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 78px" }}
      className={cn(
        "flex w-full flex-col gap-1 border-border border-b px-3 py-2 text-left transition-colors",
        "hover:bg-muted",
        selected && "bg-muted",
        tone === "warning" && "bg-primary/10 hover:bg-primary/15",
        tone === "stale" && "bg-primary/20 hover:bg-primary/25",
      )}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground/70 text-xs uppercase tracking-wide">
          {formatKind(item.kind)}
        </span>
        <StatePill state={item.state} />
        {pinned && (
          <span className="font-mono text-[10px] text-primary" title="Pinned">
            ●
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-muted-foreground/70">
          <FreshnessStamp updatedAt={item.updatedAt} thresholdDays={staleThresholdDays} />
          <span>#{item.itemNumber}</span>
        </span>
      </div>
      <div className="line-clamp-2 text-foreground text-sm">{item.title}</div>
      {hasMeta && (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted-foreground/70">
          {item.assignee && <span className="truncate">{item.assignee}</span>}
          {item.assignee && tags.length > 0 && (
            <span aria-hidden className="text-muted-foreground/70">
              ·
            </span>
          )}
          {shownTags.map((t) => (
            <span
              key={t}
              title={t}
              className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
            >
              {displayTag(t)}
            </span>
          ))}
          {extraTags > 0 && <span className="text-muted-foreground/70">+{extraTags}</span>}
        </div>
      )}
    </Link>
  );
}

export function PinnedRow({
  projectSlug,
  item,
  selected,
}: {
  projectSlug: string;
  item: PinnedListItem;
  selected: boolean;
}) {
  return (
    <Link
      href={`/projects/${projectSlug}/items/${item.itemNumber}`}
      className={cn(
        "flex items-center gap-2 border-border border-b px-3 py-1.5 text-xs transition-colors",
        "hover:bg-muted",
        selected && "bg-muted",
      )}
    >
      <span className="text-muted-foreground/70 text-xs uppercase tracking-wide">
        {formatKind(item.kind)}
      </span>
      <StatePill state={item.state} />
      <span className="flex-1 truncate text-foreground">{item.title}</span>
      <span className="font-mono text-[10px] text-muted-foreground/70">#{item.itemNumber}</span>
    </Link>
  );
}

export function EmptyMessage({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <div
      className={cn(
        "flex h-full items-center justify-center p-6 text-center text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground/70",
      )}
    >
      {text}
    </div>
  );
}
