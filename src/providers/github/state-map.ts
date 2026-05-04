// GitHub has no native "blocked" / "needs info" — the provider encodes
// those as labels, mirroring AzDO's tag encoding. Sync reads labels first;
// the executor merges add/remove plans into the existing label set so
// unrelated labels survive a transition.

import { ProviderError } from "@/core/provider";
import { mergeStringSet } from "@/core/tag-merge";
import { canonicalIntentsFor, type ItemState, type TransitionIntent } from "@/core/types";

export type GithubIssueState = "open" | "closed";
export type GithubStateReason = "completed" | "not_planned" | "duplicate" | "reopened" | null;

export type GithubIssueStatus = {
  state: GithubIssueState;
  stateReason: GithubStateReason;
};

export const LABEL_BLOCKED = "blocked";
export const LABEL_NEEDS_INFO = "needs-info";
export const LABEL_WONTFIX = "wontfix";
const SOFT_LABELS = [LABEL_BLOCKED, LABEL_NEEDS_INFO, LABEL_WONTFIX] as const;

/**
 * Lowercased set of labels that encode canonical state on GitHub. The
 * `setTags` boundary uses this to keep state-encoding labels intact when a
 * caller intends to rewrite the user-facing tag set.
 */
export const STATE_ENCODING_LABELS: ReadonlySet<string> = new Set(SOFT_LABELS);

/**
 * Map a GitHub issue's `(state, state_reason, labels)` to the canonical
 * `ItemState`. Labels win over the state field — an open issue tagged
 * `blocked` is canonical-blocked, even though GitHub still shows it as open.
 *
 * `new` is reserved for items the cache has never seen before; live GitHub
 * issues are always at least `active` (or one of the soft states).
 */
export function toCanonicalState(status: GithubIssueStatus, labels: readonly string[]): ItemState {
  const lower = new Set(labels.map((l) => l.toLowerCase()));
  if (lower.has(LABEL_BLOCKED)) return "blocked";
  if (lower.has(LABEL_NEEDS_INFO)) return "needs_info";
  if (status.state === "open") return "active";
  if (status.stateReason === "not_planned" || status.stateReason === "duplicate") return "closed";
  return "resolved";
}

export type GithubTransitionPlan = {
  state: GithubIssueState;
  stateReason: GithubStateReason;
  labelsToAdd: readonly string[];
  labelsToRemove: readonly string[];
};

/**
 * Map a `TransitionIntent` to the GitHub mutation payload — both the
 * `(state, state_reason)` change and the soft-state label diff.
 *
 * Soft states (`pause`, `block`, `needs_info`) keep the issue open and
 * encode the canonical state via labels. `start_work` and `reopen` strip
 * every soft label so the issue lands in canonical `active`.
 */
export function planForIntent(intent: TransitionIntent): GithubTransitionPlan {
  switch (intent) {
    case "start_work":
      return {
        state: "open",
        stateReason: null,
        labelsToAdd: [],
        labelsToRemove: SOFT_LABELS,
      };
    case "pause":
      return {
        state: "open",
        stateReason: null,
        labelsToAdd: [],
        labelsToRemove: SOFT_LABELS,
      };
    case "block":
      return {
        state: "open",
        stateReason: null,
        labelsToAdd: [LABEL_BLOCKED],
        labelsToRemove: [LABEL_NEEDS_INFO, LABEL_WONTFIX],
      };
    case "needs_info":
      return {
        state: "open",
        stateReason: null,
        labelsToAdd: [LABEL_NEEDS_INFO],
        labelsToRemove: [LABEL_BLOCKED, LABEL_WONTFIX],
      };
    case "close_done":
      return {
        state: "closed",
        stateReason: "completed",
        labelsToAdd: [],
        labelsToRemove: SOFT_LABELS,
      };
    case "close_wontfix":
      return {
        state: "closed",
        stateReason: "not_planned",
        labelsToAdd: [LABEL_WONTFIX],
        labelsToRemove: [LABEL_BLOCKED, LABEL_NEEDS_INFO],
      };
    // GitHub exposes `state_reason: "duplicate"` on the issue update endpoint;
    // surfacing it here makes the timeline display "closed this as duplicate"
    // instead of falling back to "not planned". Soft labels are stripped —
    // duplicate closure shouldn't retain `wontfix`/`blocked`/`needs-info`.
    case "close_duplicate":
      return {
        state: "closed",
        stateReason: "duplicate",
        labelsToAdd: [],
        labelsToRemove: SOFT_LABELS,
      };
    case "reopen":
      return {
        state: "open",
        stateReason: "reopened",
        labelsToAdd: [],
        labelsToRemove: SOFT_LABELS,
      };
    default: {
      const exhaustive: never = intent;
      throw new ProviderError(`Unknown transition intent: ${String(exhaustive)}`);
    }
  }
}

/**
 * Apply a transition plan to the existing label set: drop labels in
 * `labelsToRemove`, then add labels in `labelsToAdd`. Case-insensitive on
 * removal so soft labels are stripped regardless of how the issue stored
 * them. Result is sorted for deterministic API payloads.
 */
export function mergeLabels(current: readonly string[], plan: GithubTransitionPlan): string[] {
  return mergeStringSet(current, plan.labelsToRemove, plan.labelsToAdd);
}

/**
 * Canonical states GitHub can produce — used by the reverse-mapping arch
 * test. With label-based soft-state encoding, GitHub now reaches the full
 * canonical set except `new` (reserved for items the cache has never seen).
 */
export const REACHABLE_CANONICAL_STATES: readonly ItemState[] = [
  "active",
  "blocked",
  "needs_info",
  "resolved",
  "closed",
];

/**
 * Intents the UI should expose for a GitHub item in `state`.
 *
 * GitHub has no distinct "paused" representation — `pause` and `start_work`
 * both map to "open with no soft labels", which is the same shape the
 * canonical `active` state translates back to. So `pause` from `active`
 * would stage a proposal whose plan equals the current state and produce
 * no observable change after confirm. Drop it. `new` is unreachable on
 * GitHub (see `toCanonicalState`), so its branch is moot but kept in
 * sync with the canonical mapping for completeness.
 */
export function availableIntentsForState(state: ItemState): readonly TransitionIntent[] {
  const canonical = canonicalIntentsFor(state);
  if (state === "active") return canonical.filter((i) => i !== "pause");
  if (state === "new") return canonical.filter((i) => i !== "start_work");
  return canonical;
}
