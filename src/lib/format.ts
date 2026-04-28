/**
 * Human-friendly formatters used across the UI.
 *
 * `formatRelative` returns terse age strings ("just now", "5m ago", "3d
 * ago") suitable for status footers and item rows. Components should call
 * it with a tick of their own (e.g. setInterval) when they want the label
 * to refresh — this module is pure.
 */

import type { ItemKind, ItemState, TransitionIntent } from "@/core/types";
import { githubProfileUrl } from "@/providers/github/profile";

export function mostRecent(dates: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (!best || d.getTime() > best.getTime()) best = d;
  }
  return best;
}

export function formatRelative(input: Date | string | null | undefined): string {
  if (!input) return "—";
  const date = typeof input === "string" ? new Date(input) : input;
  const ms = Date.now() - date.getTime();
  if (Number.isNaN(ms)) return "—";
  if (ms < 0) return "in the future";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 30) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

const STATE_LABELS: Record<ItemState, string> = {
  new: "New",
  active: "Active",
  blocked: "Blocked",
  needs_info: "Needs info",
  resolved: "Resolved",
  closed: "Closed",
};

export function formatState(state: ItemState | string): string {
  return STATE_LABELS[state as ItemState] ?? state;
}

const KIND_LABELS: Record<ItemKind, string> = {
  epic: "Epic",
  feature: "Feature",
  story: "Story",
  task: "Task",
  bug: "Bug",
};

export function formatKind(kind: ItemKind | string): string {
  return KIND_LABELS[kind as ItemKind] ?? kind;
}

const INTENT_LABELS: Record<TransitionIntent, string> = {
  start_work: "Start work",
  pause: "Pause",
  block: "Block",
  needs_info: "Needs info",
  close_done: "Close (done)",
  close_wontfix: "Close (won't fix)",
  reopen: "Reopen",
};

export function formatIntent(intent: TransitionIntent | string): string {
  return INTENT_LABELS[intent as TransitionIntent] ?? intent;
}

/**
 * GitHub-style labels often embed emoji shortcodes like
 * `:chart_with_upwards_trend:` inside the label name, which renders as
 * noisy literal text. Strip them for display only — the raw tag string
 * stays authoritative for filtering/storage.
 */
export function displayTag(raw: string): string {
  return (
    raw
      .replace(/:[a-z0-9_+-]+:/gi, "")
      .replace(/\s+/g, " ")
      .trim() || raw
  );
}

/**
 * Build a public profile URL for the user identifier the provider stamps
 * into `Item.author`. Each provider package owns its own client-safe URL
 * builder (see `src/providers/<name>/profile.ts`); this is just the kind
 * dispatcher — same shape as `src/lib/provider-logos.tsx`. Providers
 * without a stable profile URL (Azure DevOps today) get no entry and the
 * UI falls back to plain text.
 */
export function providerProfileUrl(
  providerKind: string | null | undefined,
  identity: string | null | undefined,
): string | null {
  if (!providerKind || !identity) return null;
  switch (providerKind) {
    case "github":
      return githubProfileUrl(identity);
    default:
      return null;
  }
}
