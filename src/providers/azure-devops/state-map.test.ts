/**
 * Bidirectional contract test for the AzDO state map.
 *
 * Mirrors the GitHub state-map test: every canonical `ItemState` AzDO
 * commits to supporting must be reachable from at least one
 * `(state, tags)` pair. Catches accidental drift like "we added a new
 * canonical state in core/types.ts but the AzDO map can't produce it."
 *
 * The Agile template has no native blocked / needs_info states, so the
 * pairs include the soft-tag encoding that `mapState` recognizes.
 */

import { describe, expect, it } from "vitest";
import type { ItemState, TransitionIntent } from "@/core/types";
import { ITEM_STATES, TRANSITION_INTENTS } from "@/core/types";
import {
  mapState,
  mergeTags,
  planForIntent,
  REACHABLE_CANONICAL_STATES,
  TAG_BLOCKED,
  TAG_NEEDS_INFO,
  TAG_WONTFIX,
} from "@/providers/azure-devops/state-map";

const PAIRS: ReadonlyArray<{ state: string; tags: readonly string[] }> = [
  { state: "New", tags: [] },
  { state: "Active", tags: [] },
  { state: "Active", tags: [TAG_BLOCKED] },
  { state: "Active", tags: [TAG_NEEDS_INFO] },
  { state: "Resolved", tags: [] },
  { state: "Closed", tags: [] },
  { state: "Closed", tags: [TAG_WONTFIX] },
  { state: "Removed", tags: [] },
];

describe("azure-devops state-map", () => {
  it("REACHABLE_CANONICAL_STATES is a subset of canonical ItemState", () => {
    for (const state of REACHABLE_CANONICAL_STATES) {
      expect(ITEM_STATES).toContain(state);
    }
  });

  it("every reachable canonical state is produced by at least one (state, tags) pair", () => {
    const produced = new Set<ItemState>(PAIRS.map((p) => mapState("task", p.state, p.tags)));
    for (const state of REACHABLE_CANONICAL_STATES) {
      expect(produced.has(state)).toBe(true);
    }
  });

  it("planForIntent round-trips back to a canonical state for every supported intent", () => {
    const supported: TransitionIntent[] = [
      "start_work",
      "pause",
      "block",
      "needs_info",
      "close_done",
      "close_wontfix",
      "reopen",
    ];
    for (const intent of supported) {
      const plan = planForIntent(intent);
      // Apply the plan to an empty tag set, then translate back.
      const tags = mergeTags([], plan);
      const canonical = mapState("task", plan.state ?? "Active", tags);
      expect(REACHABLE_CANONICAL_STATES).toContain(canonical);
    }
  });

  it("every TransitionIntent is mapped — no silent fall-through", () => {
    for (const intent of TRANSITION_INTENTS) {
      const plan = planForIntent(intent);
      expect(plan).toBeDefined();
      // State may be null only for tag-only plans (none today, but the type
      // allows it). Soft-state intents must add at least one tag.
      if (plan.state === null) {
        expect(plan.tagsToAdd.length).toBeGreaterThan(0);
      }
    }
  });

  it("mergeTags removes soft tags on close_done and adds wontfix on close_wontfix", () => {
    const closeDone = mergeTags([TAG_BLOCKED, "feature-flag"], planForIntent("close_done"));
    expect(closeDone).not.toContain(TAG_BLOCKED);
    expect(closeDone).toContain("feature-flag");

    const closeWontfix = mergeTags([], planForIntent("close_wontfix"));
    expect(closeWontfix).toContain(TAG_WONTFIX);
  });

  it("mapState honors soft tags over the state field", () => {
    expect(mapState("task", "Active", [TAG_BLOCKED])).toBe("blocked");
    expect(mapState("task", "Active", [TAG_NEEDS_INFO])).toBe("needs_info");
    expect(mapState("task", "Active", [])).toBe("active");
  });
});
