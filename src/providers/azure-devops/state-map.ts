// Soft states (`blocked`, `needs_info`, `closed-as-wontfix`) have no
// native Agile representation, so we encode them as tags alongside the
// state field. Out-of-vocabulary states fall back to `active` so sync
// doesn't fail on a process template we haven't catalogued.

import { ProviderError } from "@/core/provider";
import {
  canonicalIntentsFor,
  type ItemKind,
  type ItemState,
  type TransitionIntent,
} from "@/core/types";

export const KIND_BY_WIT: Readonly<Record<string, ItemKind>> = {
  Epic: "epic",
  Feature: "feature",
  "User Story": "story",
  "Product Backlog Item": "story",
  Requirement: "story",
  Task: "task",
  Bug: "bug",
};

export const WIT_BY_KIND: Readonly<Record<ItemKind, string>> = {
  epic: "Epic",
  feature: "Feature",
  story: "User Story",
  task: "Task",
  bug: "Bug",
};

const AGILE_STATE_MAP: Readonly<Record<string, ItemState>> = {
  New: "new",
  Active: "active",
  Resolved: "resolved",
  Closed: "closed",
  Removed: "closed",
};

export const TAG_BLOCKED = "blocked";
export const TAG_NEEDS_INFO = "needs-info";
export const TAG_WONTFIX = "wontfix";
const SOFT_TAGS = [TAG_BLOCKED, TAG_NEEDS_INFO, TAG_WONTFIX] as const;

/** Lowercased set of tags AzDO uses to encode canonical state. */
export const STATE_ENCODING_TAGS: ReadonlySet<string> = new Set(SOFT_TAGS);

/**
 * Translate an AzDO state string to canonical, taking into account the
 * tag-encoded soft states. Tags win over the state field — an "Active" item
 * tagged `blocked` is canonical-blocked, even though AzDO still shows it as
 * Active. Unknown states fall back to `active` so sync doesn't fail on a
 * process template state we haven't catalogued.
 */
export function mapState(_kind: ItemKind, state: string, tags: readonly string[]): ItemState {
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));
  if (tagSet.has(TAG_BLOCKED)) return "blocked";
  if (tagSet.has(TAG_NEEDS_INFO)) return "needs_info";
  return AGILE_STATE_MAP[state] ?? "active";
}

/** AzDO `Removed` state should archive the item locally; sync flips a flag. */
export function isRemoved(state: string): boolean {
  return state === "Removed";
}

export type TransitionPlan = {
  state: string | null;
  tagsToAdd: readonly string[];
  tagsToRemove: readonly string[];
};

/**
 * Map a canonical intent to an AzDO state field + tag mutation.
 *
 * The Agile template uses one state vocabulary across kinds, so the plan
 * doesn't depend on `kind` today. If a non-Agile template ever drops a
 * state for a specific kind, re-introduce a kind argument.
 */
export function planForIntent(intent: TransitionIntent): TransitionPlan {
  switch (intent) {
    case "start_work":
      return { state: "Active", tagsToAdd: [], tagsToRemove: SOFT_TAGS };
    case "pause":
      return { state: "New", tagsToAdd: [], tagsToRemove: SOFT_TAGS };
    case "block":
      return {
        state: "Active",
        tagsToAdd: [TAG_BLOCKED],
        tagsToRemove: [TAG_NEEDS_INFO, TAG_WONTFIX],
      };
    case "needs_info":
      return {
        state: "Active",
        tagsToAdd: [TAG_NEEDS_INFO],
        tagsToRemove: [TAG_BLOCKED, TAG_WONTFIX],
      };
    case "close_done":
      return { state: "Closed", tagsToAdd: [], tagsToRemove: SOFT_TAGS };
    case "close_wontfix":
      return {
        state: "Closed",
        tagsToAdd: [TAG_WONTFIX],
        tagsToRemove: [TAG_BLOCKED, TAG_NEEDS_INFO],
      };
    // Agile has no first-class "duplicate" reason on the state field; we
    // reuse `Closed` and let the comment body name the canonical item. Soft
    // tags are stripped on close so the row doesn't end up tagged
    // `wontfix`/`blocked`/`needs-info` after a duplicate-close.
    case "close_duplicate":
      return { state: "Closed", tagsToAdd: [], tagsToRemove: SOFT_TAGS };
    case "reopen":
      return { state: "Active", tagsToAdd: [], tagsToRemove: SOFT_TAGS };
    default: {
      const exhaustive: never = intent;
      throw new ProviderError(`Unknown transition intent: ${String(exhaustive)}`);
    }
  }
}

export function mergeTags(current: readonly string[], plan: TransitionPlan): string[] {
  const removeSet = new Set(plan.tagsToRemove.map((t) => t.toLowerCase()));
  const out = new Set<string>();
  for (const tag of current) {
    if (!tag) continue;
    if (removeSet.has(tag.toLowerCase())) continue;
    out.add(tag);
  }
  for (const tag of plan.tagsToAdd) {
    out.add(tag);
  }
  return Array.from(out).sort();
}

/**
 * Canonical states an AzDO project can produce — used by the reverse-mapping
 * arch test to prove every state we *want to support on AzDO* is reachable
 * from some `(state, tags)` pair.
 */
export const REACHABLE_CANONICAL_STATES: readonly ItemState[] = [
  "new",
  "active",
  "blocked",
  "needs_info",
  "resolved",
  "closed",
];

/**
 * Intents the UI should expose for an AzDO item in `state`. The Agile
 * template represents every canonical intent as a real state or tag
 * change, so the canonical list applies as-is.
 */
export function availableIntentsForState(state: ItemState): readonly TransitionIntent[] {
  return canonicalIntentsFor(state);
}
