"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { metaLabelFaintClass } from "@/lib/form-classes";
import { displayTag, formatKind } from "@/lib/format";
import { freshnessTone } from "@/lib/staleness";
import { cn } from "@/lib/utils";
import { FreshnessStamp } from "@/ui/items/freshness";
import { StatePill } from "@/ui/items/state-pill";

export type ListItem = {
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

export type PinnedListItem = {
  id: string;
  providerItemId: string;
  title: string;
  state: string;
  kind: string;
};

export function ItemRow({
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
    <div className="group/row relative border-b border-border">
      <Link
        href={`/projects/${projectId}/items/${item.id}`}
        className={cn(
          "flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors",
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
              <span
                key={t}
                title={t}
                className="rounded bg-surface-alt px-1.5 py-0.5 text-fg-muted"
              >
                {displayTag(t)}
              </span>
            ))}
            {extraTags > 0 && <span className="text-fg-faint">+{extraTags}</span>}
          </div>
        )}
      </Link>
      {item.url ? (
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title="Open in provider (new tab)"
          aria-label={`Open ${item.providerItemId} in a new tab`}
          className="absolute right-1.5 top-1.5 rounded bg-surface p-1 text-fg-faint opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          <ExternalLink aria-hidden="true" className="h-3 w-3" />
        </a>
      ) : null}
    </div>
  );
}

export function PinnedRow({
  projectId,
  item,
  selected,
}: {
  projectId: string;
  item: PinnedListItem;
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

export function EmptyMessage({ text, tone }: { text: string; tone?: "error" }) {
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
