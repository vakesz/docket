"use client";

import { Check, ChevronDown, X } from "lucide-react";
import type { BacklogBucket, ItemKind } from "@/core/types";
import { avatarUrl } from "@/lib/avatar-url";
import { displayTag, formatKind } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CreateItemForm } from "@/ui/items/create-item-form";
import { Input } from "@/ui/primitives/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/primitives/popover";

export const ASSIGNEE_UNASSIGNED = "__unassigned";

export type FilterState = {
  bucket: BacklogBucket;
  kind: ItemKind | "all";
  activeTags: ReadonlySet<string>;
  activeAssignees: ReadonlySet<string>;
  query: string;
  tagsExpanded: boolean;
  assigneesExpanded: boolean;
};

export type FilterHandlers = {
  setBucket: (b: BacklogBucket) => void;
  setKind: (k: ItemKind | "all") => void;
  setActiveTags: (next: ReadonlySet<string>) => void;
  setActiveAssignees: (next: ReadonlySet<string>) => void;
  setQuery: (q: string) => void;
  setTagsExpanded: (fn: (v: boolean) => boolean) => void;
  setAssigneesExpanded: (fn: (v: boolean) => boolean) => void;
};

const BUCKET_LABEL: Record<BacklogBucket, string> = {
  open: "Open",
  closed: "Closed",
  archived: "Archived",
  all: "All",
};

const BUCKET_TITLE: Record<BacklogBucket, string> = {
  open: "new, active, blocked, needs info",
  closed: "resolved, closed",
  archived: "items the provider no longer returns",
  all: "every state, including archived",
};

function toggle(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function summarizeSelection(selected: ReadonlySet<string>, meIdentifier: string | null): string {
  if (selected.size === 0) return "Anyone";
  if (selected.size === 1) {
    const only = [...selected][0];
    if (!only) return "Anyone";
    if (only === ASSIGNEE_UNASSIGNED) return "Unassigned";
    return only === meIdentifier ? "You" : only;
  }
  return `${selected.size} selected`;
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-1 w-14 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

function ClearButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
      title="Clear selection"
    >
      <X aria-hidden="true" className="size-3" />
      <span>clear</span>
    </button>
  );
}

function CountBadge({ n, selected }: { n: number; selected: boolean }) {
  return (
    <span
      className={cn(
        "rounded px-1 py-px text-[9px] tabular-nums",
        selected
          ? "bg-primary-foreground/15 text-primary-foreground"
          : "bg-background/60 text-muted-foreground/70",
      )}
    >
      {n}
    </span>
  );
}

export function FilterBar({
  projectSlug,
  state,
  handlers,
  visibleKinds,
  tagCounts,
  tagCollapseLimit,
  assigneeCounts,
  assigneeCollapseLimit,
  assigneeSelectorStyle,
  meIdentifier,
  showArchivedBucket,
  providerKind,
  providerHasAvatars,
  showAvatars,
}: {
  projectSlug: string;
  state: FilterState;
  handlers: FilterHandlers;
  visibleKinds: Array<ItemKind | "all">;
  tagCounts: Array<[string, number]>;
  tagCollapseLimit: number;
  assigneeCounts: Array<[string, number]>;
  assigneeCollapseLimit: number;
  assigneeSelectorStyle: "chips" | "dropdown";
  meIdentifier: string | null;
  showArchivedBucket: boolean;
  providerKind: string;
  /** Does this project's provider expose an avatar fetcher? Threaded down
   * so the avatar chip can short-circuit to the initials fallback for
   * provider kinds without an avatar surface — no client-side branch on
   * specific provider names. */
  providerHasAvatars: boolean;
  showAvatars: boolean;
}) {
  const { bucket, kind, activeTags, activeAssignees, query, tagsExpanded, assigneesExpanded } =
    state;
  const buckets: BacklogBucket[] = showArchivedBucket
    ? ["open", "closed", "archived", "all"]
    : ["open", "closed", "all"];

  const onToggleTag = (value: string) => handlers.setActiveTags(toggle(activeTags, value));
  const onClearTags = () => handlers.setActiveTags(new Set());
  const onToggleAssignee = (value: string) => {
    handlers.setActiveAssignees(toggle(activeAssignees, value));
  };
  const onClearAssignees = () => handlers.setActiveAssignees(new Set());

  return (
    <div className="flex flex-col gap-2 border-b border-border p-3">
      <div className="flex items-center gap-2">
        <Input
          type="search"
          placeholder="Filter by title, id, tag…"
          value={query}
          onChange={(e) => handlers.setQuery(e.target.value)}
          className="min-w-0 flex-1 text-xs"
        />
        <CreateItemForm projectSlug={projectSlug} />
      </div>

      <FilterRow label="State">
        <SegmentedGroup>
          {buckets.map((b) => (
            <SegmentedButton
              key={b}
              selected={bucket === b}
              onClick={() => handlers.setBucket(b)}
              title={BUCKET_TITLE[b]}
            >
              {BUCKET_LABEL[b]}
            </SegmentedButton>
          ))}
        </SegmentedGroup>
      </FilterRow>

      {visibleKinds.length > 2 && (
        <FilterRow label="Kind">
          <SegmentedGroup>
            {visibleKinds.map((k) => (
              <SegmentedButton key={k} selected={kind === k} onClick={() => handlers.setKind(k)}>
                {k === "all" ? "All" : formatKind(k)}
              </SegmentedButton>
            ))}
          </SegmentedGroup>
        </FilterRow>
      )}

      {tagCounts.length > 0 && (
        <FilterRow label="Tag">
          {(tagsExpanded ? tagCounts : tagCounts.slice(0, tagCollapseLimit)).map(([t, n]) => {
            const label = displayTag(t);
            const selected = activeTags.has(t);
            return (
              <button
                type="button"
                key={t}
                onClick={() => onToggleTag(t)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] lowercase tracking-wide transition-colors",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-card",
                )}
                title={`${t} — ${n} item${n === 1 ? "" : "s"}`}
              >
                <span>{label}</span>
                <CountBadge n={n} selected={selected} />
              </button>
            );
          })}
          {tagCounts.length > tagCollapseLimit && (
            <button
              type="button"
              onClick={() => handlers.setTagsExpanded((v) => !v)}
              className="rounded-full px-2 py-0.5 font-mono text-[10px] lowercase tracking-wide text-muted-foreground/70 hover:bg-muted"
            >
              {tagsExpanded ? "show less" : `+${tagCounts.length - tagCollapseLimit} more`}
            </button>
          )}
          {activeTags.size > 0 && <ClearButton onClick={onClearTags} />}
        </FilterRow>
      )}

      {assigneeCounts.length > 0 || meIdentifier !== null ? (
        assigneeSelectorStyle === "dropdown" ? (
          <FilterRow label="Assignee">
            <AssigneeDropdown
              assigneeCounts={assigneeCounts}
              activeAssignees={activeAssignees}
              meIdentifier={meIdentifier}
              onToggle={onToggleAssignee}
              onClear={onClearAssignees}
              providerKind={providerKind}
              providerHasAvatars={providerHasAvatars}
              showAvatars={showAvatars}
            />
            {activeAssignees.size > 0 && <ClearButton onClick={onClearAssignees} />}
          </FilterRow>
        ) : (
          <FilterRow label="Assignee">
            <AssigneeChips
              assigneeCounts={assigneeCounts}
              activeAssignees={activeAssignees}
              assigneesExpanded={assigneesExpanded}
              assigneeCollapseLimit={assigneeCollapseLimit}
              meIdentifier={meIdentifier}
              onToggle={onToggleAssignee}
              onToggleExpanded={() => handlers.setAssigneesExpanded((v) => !v)}
              providerKind={providerKind}
              providerHasAvatars={providerHasAvatars}
              showAvatars={showAvatars}
            />
            {activeAssignees.size > 0 && <ClearButton onClick={onClearAssignees} />}
          </FilterRow>
        )
      ) : null}
    </div>
  );
}

function SegmentedGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border">{children}</div>
  );
}

function SegmentedButton({
  selected,
  onClick,
  title,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "px-2.5 py-1 font-mono text-[10px] lowercase tracking-wide transition-colors not-first:border-l not-first:border-border",
        selected
          ? "bg-primary text-primary-foreground"
          : "bg-card text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function AssigneeChips({
  assigneeCounts,
  activeAssignees,
  assigneesExpanded,
  assigneeCollapseLimit,
  meIdentifier,
  onToggle,
  onToggleExpanded,
  providerKind,
  providerHasAvatars,
  showAvatars,
}: {
  assigneeCounts: Array<[string, number]>;
  activeAssignees: ReadonlySet<string>;
  assigneesExpanded: boolean;
  assigneeCollapseLimit: number;
  meIdentifier: string | null;
  onToggle: (value: string) => void;
  onToggleExpanded: () => void;
  providerKind: string;
  providerHasAvatars: boolean;
  showAvatars: boolean;
}) {
  const visibleCounts = assigneesExpanded
    ? assigneeCounts
    : assigneeCounts.slice(0, assigneeCollapseLimit);
  const overflow = assigneeCounts.length - assigneeCollapseLimit;

  return (
    <>
      <ChipPill
        label="unassigned"
        selected={activeAssignees.has(ASSIGNEE_UNASSIGNED)}
        onClick={() => onToggle(ASSIGNEE_UNASSIGNED)}
      />
      {visibleCounts.map(([name, n]) => {
        const selected = activeAssignees.has(name);
        const isMe = meIdentifier !== null && name === meIdentifier;
        return (
          <button
            type="button"
            key={name}
            onClick={() => onToggle(name)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 font-mono text-[10px] lowercase tracking-wide transition-colors",
              showAvatars ? "pl-0.5" : "pl-2",
              selected
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-card",
            )}
            title={`${name}${isMe ? " (you)" : ""} — ${n} item${n === 1 ? "" : "s"}`}
          >
            {showAvatars ? (
              <AssigneeAvatar
                name={name}
                providerKind={providerKind}
                providerHasAvatars={providerHasAvatars}
              />
            ) : null}
            <span>{name}</span>
            {isMe ? (
              <span
                className={cn(
                  "font-mono text-[9px] uppercase",
                  selected ? "text-primary-foreground/75" : "text-muted-foreground/70",
                )}
              >
                you
              </span>
            ) : null}
            <CountBadge n={n} selected={selected} />
          </button>
        );
      })}
      {overflow > 0 && (
        <button
          type="button"
          onClick={onToggleExpanded}
          className="rounded-full px-2 py-0.5 font-mono text-[10px] lowercase tracking-wide text-muted-foreground/70 hover:bg-muted"
        >
          {assigneesExpanded ? "show less" : `+${overflow} more`}
        </button>
      )}
    </>
  );
}

function ChipPill({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-2 py-0.5 font-mono text-[10px] lowercase tracking-wide transition-colors",
        selected
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-card",
      )}
    >
      {label}
    </button>
  );
}

/**
 * Avatars resolve through `/api/avatars/{providerKind}/{identifier}`, which
 * serves cached bytes out of the `Avatar` table. The route lazily
 * populates on first hit (GitHub uses the public CDN; AzDO assignees stay
 * 404 until the signed-in user's row supplies bytes) and returns a
 * deterministic 404 when nothing is available so the `onError` fallback to
 * an initial chip kicks in. The `providerHasAvatars` gate short-circuits
 * the request entirely for provider kinds without an avatar fetcher
 * registered — same effective UX without the doomed round-trip.
 */
function AssigneeAvatar({
  name,
  providerKind,
  providerHasAvatars,
}: {
  name: string;
  providerKind: string;
  providerHasAvatars: boolean;
}) {
  const url = providerHasAvatars ? avatarUrl(providerKind, name) : null;
  const initial = name.charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      className="relative flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full bg-background/40 font-sans text-[8px] font-medium text-muted-foreground/70"
    >
      <span>{initial}</span>
      {url ? (
        <>
          {/* biome-ignore lint/performance/noImgElement: same-origin avatar route already streams cached bytes; next/image would add a layout layer for no benefit at this size. */}
          <img
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 size-full object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        </>
      ) : null}
    </span>
  );
}

function AssigneeDropdown({
  assigneeCounts,
  activeAssignees,
  meIdentifier,
  onToggle,
  onClear,
  providerKind,
  providerHasAvatars,
  showAvatars,
}: {
  assigneeCounts: Array<[string, number]>;
  activeAssignees: ReadonlySet<string>;
  meIdentifier: string | null;
  onToggle: (value: string) => void;
  onClear: () => void;
  providerKind: string;
  providerHasAvatars: boolean;
  showAvatars: boolean;
}) {
  const summary = summarizeSelection(activeAssignees, meIdentifier);
  const sentinels: Array<{ value: string; label: string }> = [
    { value: ASSIGNEE_UNASSIGNED, label: "Unassigned" },
  ];

  return (
    <Popover>
      <PopoverTrigger className="inline-flex min-w-[10rem] items-center justify-between gap-2 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground hover:bg-muted">
        <span className="truncate">{summary}</span>
        <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/70" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="z-30 max-h-72 w-64 overflow-auto rounded-md p-1 text-xs"
      >
        <button
          type="button"
          onClick={onClear}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left",
            activeAssignees.size === 0
              ? "bg-primary/10 text-foreground"
              : "text-muted-foreground hover:bg-muted",
          )}
        >
          <span>Anyone</span>
          {activeAssignees.size === 0 ? <Check aria-hidden="true" className="size-3" /> : null}
        </button>
        <div className="my-1 border-t border-border" />
        {sentinels.map((s) => {
          const selected = activeAssignees.has(s.value);
          return (
            <button
              type="button"
              key={s.value}
              onClick={() => onToggle(s.value)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left",
                selected ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              <span>{s.label}</span>
              {selected ? <Check aria-hidden="true" className="size-3" /> : null}
            </button>
          );
        })}
        {assigneeCounts.length > 0 ? (
          <>
            <div className="my-1 border-t border-border" />
            {assigneeCounts.map(([name, n]) => {
              const selected = activeAssignees.has(name);
              const isMe = meIdentifier !== null && name === meIdentifier;
              return (
                <button
                  type="button"
                  key={name}
                  onClick={() => onToggle(name)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left",
                    selected
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    {showAvatars ? (
                      <AssigneeAvatar
                        name={name}
                        providerKind={providerKind}
                        providerHasAvatars={providerHasAvatars}
                      />
                    ) : null}
                    <span className="truncate">{name}</span>
                    {isMe ? (
                      <span className="font-mono text-[9px] uppercase text-muted-foreground/70">
                        you
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-[9px] tabular-nums text-muted-foreground/70">
                      {n}
                    </span>
                    {selected ? <Check aria-hidden="true" className="size-3" /> : null}
                  </span>
                </button>
              );
            })}
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
