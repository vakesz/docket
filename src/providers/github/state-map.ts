/**
 * Bidirectional translation between GitHub issue states and canonical
 * `ItemState` / `TransitionIntent`.
 *
 * GitHub stores issue state as `(state, state_reason)`:
 *   - `state` is "open" | "closed"
 *   - `state_reason` is "completed" | "not_planned" | "reopened" | null
 *
 * The arch test in `src/providers/__arch__.test.ts` walks every `ItemState`
 * and asserts at least one GitHub `(state, state_reason)` pair maps to it.
 * That guarantees no canonical state is unreachable through GitHub.
 */

import { ProviderError } from "@/core/provider";
import type { ItemState, TransitionIntent } from "@/core/types";

export type GithubIssueState = "open" | "closed";
export type GithubStateReason = "completed" | "not_planned" | "reopened" | null;

export type GithubIssueStatus = {
  state: GithubIssueState;
  stateReason: GithubStateReason;
};

/**
 * Map a GitHub issue's `(state, state_reason)` to the canonical `ItemState`.
 *
 * `new` is reserved for items the cache has never seen before; live GitHub
 * issues are always at least `active`. `blocked` and `needs_info` have no
 * native GitHub representation — sync-time inference (e.g. label-based)
 * lives elsewhere.
 */
export function toCanonicalState(status: GithubIssueStatus): ItemState {
  if (status.state === "open") {
    return "active";
  }
  if (status.stateReason === "not_planned") {
    return "closed";
  }
  return "resolved";
}

/**
 * Map a `TransitionIntent` to the GitHub mutation payload.
 *
 * Returns the (state, stateReason) the GitHub API expects on PATCH /issues.
 * Throws `ProviderError` for intents GitHub can't represent — the proposal
 * pipeline surfaces that as a non-applicable intent instead of attempting
 * the write.
 */
export function fromTransitionIntent(intent: TransitionIntent): GithubIssueStatus {
  switch (intent) {
    case "start_work":
      return { state: "open", stateReason: null };
    case "reopen":
      return { state: "open", stateReason: "reopened" };
    case "close_done":
      return { state: "closed", stateReason: "completed" };
    case "close_wontfix":
      return { state: "closed", stateReason: "not_planned" };
    case "pause":
    case "block":
    case "needs_info":
      throw new ProviderError(`GitHub has no native representation for intent '${intent}'`);
    default: {
      const exhaustive: never = intent;
      throw new ProviderError(`Unknown transition intent: ${String(exhaustive)}`);
    }
  }
}

/**
 * The set of `(state, stateReason)` pairs the canonical → GitHub direction
 * can produce, used by the reverse-mapping arch test to prove every
 * canonical state we *want to support on GitHub* round-trips. `new`,
 * `blocked`, and `needs_info` are deliberately excluded — see the docstring
 * on `toCanonicalState` above.
 */
export const REACHABLE_CANONICAL_STATES: readonly ItemState[] = ["active", "resolved", "closed"];
