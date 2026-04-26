/**
 * Bidirectional contract test for the GitHub state map.
 *
 * Mirrors the Python tree's `tests/unit/test_state_map_reverse.py`:
 * every canonical `ItemState` GitHub commits to supporting must be
 * reachable from at least one provider-native `(state, state_reason)` pair.
 *
 * Catches accidental drift like "we added a new ItemState in core/types.ts
 * but never taught the GitHub map how to produce it" — the failure mode
 * the Python test was written for after a real such incident.
 */

import { describe, expect, it } from "vitest";
import type { ItemState, TransitionIntent } from "@/core/types";
import { ITEM_STATES, TRANSITION_INTENTS } from "@/core/types";
import {
  fromTransitionIntent,
  type GithubIssueState,
  type GithubStateReason,
  REACHABLE_CANONICAL_STATES,
  toCanonicalState,
} from "@/providers/github/state-map";

const ALL_PAIRS: ReadonlyArray<{
  state: GithubIssueState;
  stateReason: GithubStateReason;
}> = [
  { state: "open", stateReason: null },
  { state: "open", stateReason: "reopened" },
  { state: "closed", stateReason: "completed" },
  { state: "closed", stateReason: "not_planned" },
  { state: "closed", stateReason: null },
];

describe("github state-map", () => {
  it("REACHABLE_CANONICAL_STATES is a subset of canonical ItemState", () => {
    for (const state of REACHABLE_CANONICAL_STATES) {
      expect(ITEM_STATES).toContain(state);
    }
  });

  it("every reachable canonical state is produced by at least one GitHub pair", () => {
    const produced = new Set<ItemState>(ALL_PAIRS.map((p) => toCanonicalState(p)));
    for (const state of REACHABLE_CANONICAL_STATES) {
      expect(produced.has(state)).toBe(true);
    }
  });

  it("fromTransitionIntent round-trips back to a canonical state for every supported intent", () => {
    const supported: TransitionIntent[] = ["start_work", "reopen", "close_done", "close_wontfix"];
    for (const intent of supported) {
      const target = fromTransitionIntent(intent);
      const canonical = toCanonicalState(target);
      expect(REACHABLE_CANONICAL_STATES).toContain(canonical);
    }
  });

  it("intents GitHub can't represent throw rather than silently coercing", () => {
    const unsupported: TransitionIntent[] = ["pause", "block", "needs_info"];
    for (const intent of unsupported) {
      expect(() => fromTransitionIntent(intent)).toThrow();
    }
  });

  it("every TransitionIntent is either mapped or explicitly rejected — no silent fall-through", () => {
    for (const intent of TRANSITION_INTENTS) {
      let accepted = false;
      let rejected = false;
      try {
        fromTransitionIntent(intent);
        accepted = true;
      } catch {
        rejected = true;
      }
      expect(accepted || rejected).toBe(true);
      expect(accepted && rejected).toBe(false);
    }
  });
});
