/**
 * Bidirectional contract test for the GitHub state map.
 *
 * Every canonical `ItemState` GitHub commits to supporting must be reachable
 * from at least one provider-native `(state, state_reason, labels)` triple,
 * and every `TransitionIntent` must map cleanly via `planForIntent` — soft
 * states ride on labels (matching the AzDO tag pattern), so no intent is
 * silently rejected anymore.
 */

import { describe, expect, it } from "vitest";
import type { ItemState } from "@/core/types";
import { ITEM_STATES, TRANSITION_INTENTS } from "@/core/types";
import {
  type GithubIssueState,
  type GithubStateReason,
  LABEL_BLOCKED,
  LABEL_NEEDS_INFO,
  LABEL_WONTFIX,
  mergeLabels,
  planForIntent,
  REACHABLE_CANONICAL_STATES,
  toCanonicalState,
} from "@/providers/github/state-map";

type Triple = {
  status: { state: GithubIssueState; stateReason: GithubStateReason };
  labels: readonly string[];
};

const ALL_TRIPLES: readonly Triple[] = [
  { status: { state: "open", stateReason: null }, labels: [] },
  { status: { state: "open", stateReason: null }, labels: [LABEL_BLOCKED] },
  { status: { state: "open", stateReason: null }, labels: [LABEL_NEEDS_INFO] },
  { status: { state: "open", stateReason: "reopened" }, labels: [] },
  { status: { state: "closed", stateReason: "completed" }, labels: [] },
  { status: { state: "closed", stateReason: "not_planned" }, labels: [] },
  { status: { state: "closed", stateReason: null }, labels: [] },
];

describe("github state-map", () => {
  it("REACHABLE_CANONICAL_STATES is a subset of canonical ItemState", () => {
    for (const state of REACHABLE_CANONICAL_STATES) {
      expect(ITEM_STATES).toContain(state);
    }
  });

  it("every reachable canonical state is produced by at least one (status, labels) triple", () => {
    const produced = new Set<ItemState>(
      ALL_TRIPLES.map((t) => toCanonicalState(t.status, t.labels)),
    );
    for (const state of REACHABLE_CANONICAL_STATES) {
      expect(produced.has(state)).toBe(true);
    }
  });

  it("labels win over the state field for soft states", () => {
    expect(toCanonicalState({ state: "open", stateReason: null }, [LABEL_BLOCKED])).toBe("blocked");
    expect(toCanonicalState({ state: "open", stateReason: null }, [LABEL_NEEDS_INFO])).toBe(
      "needs_info",
    );
  });

  it("planForIntent round-trips back to a canonical state for every intent", () => {
    for (const intent of TRANSITION_INTENTS) {
      const plan = planForIntent(intent);
      const merged = mergeLabels([], plan);
      const canonical = toCanonicalState(
        { state: plan.state, stateReason: plan.stateReason },
        merged,
      );
      expect(REACHABLE_CANONICAL_STATES).toContain(canonical);
    }
  });

  it("mergeLabels strips soft labels case-insensitively and preserves unrelated labels", () => {
    const plan = planForIntent("start_work");
    expect(mergeLabels(["BLOCKED", "feature", "Needs-Info"], plan)).toEqual(["feature"]);
  });

  it("mergeLabels adds the plan's labels and dedupes against current", () => {
    const plan = planForIntent("needs_info");
    expect(mergeLabels(["feature"], plan)).toEqual(["feature", LABEL_NEEDS_INFO]);
    expect(mergeLabels(["feature", LABEL_NEEDS_INFO], plan)).toEqual(["feature", LABEL_NEEDS_INFO]);
  });

  it("close_wontfix stamps the wontfix label so a re-sync still resolves to closed", () => {
    const plan = planForIntent("close_wontfix");
    expect(plan.state).toBe("closed");
    const merged = mergeLabels([LABEL_BLOCKED], plan);
    expect(merged).toContain(LABEL_WONTFIX);
    expect(merged).not.toContain(LABEL_BLOCKED);
  });

  it("close_duplicate closes the issue and strips soft labels without stamping wontfix", () => {
    const plan = planForIntent("close_duplicate");
    expect(plan.state).toBe("closed");
    const merged = mergeLabels([LABEL_BLOCKED, "scope:billing"], plan);
    expect(merged).not.toContain(LABEL_BLOCKED);
    expect(merged).not.toContain(LABEL_WONTFIX);
    expect(merged).not.toContain(LABEL_NEEDS_INFO);
    expect(merged).toContain("scope:billing");
    const canonical = toCanonicalState(
      { state: plan.state, stateReason: plan.stateReason },
      merged,
    );
    expect(canonical).toBe("closed");
  });
});
