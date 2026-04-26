/**
 * Architecture guard: agent tool registration order is pinned.
 *
 * Tools contribute to the LLM prompt prefix that OpenAI hashes for
 * automatic prompt caching. Reordering them — even by a single
 * position — invalidates the cache for every open conversation. This
 * test fails CI if the order in `buildToolRegistry` drifts away from
 * the canonical `TOOL_ORDER`.
 *
 * Adding a new tool is a deliberate two-step change: append it to
 * `TOOL_ORDER` at its pinned position AND in `buildToolRegistry`. Both
 * changes touch this test's input, which is the point — it's a forcing
 * function, not a nuisance.
 */

import { describe, expect, it } from "vitest";
import { buildToolRegistry, TOOL_ORDER } from "@/agent/tools/registry";
import type { ToolContext } from "@/agent/tools/types";

const fakeCtx: ToolContext = {
  // The factories don't dispatch on db at construction time — they only
  // call db inside handlers. A `null as any` keeps the test pure.
  db: null as unknown as ToolContext["db"],
  projectId: "proj_arch_test",
  userId: "user_arch_test",
  itemId: null,
  providerItemId: null,
};

describe("arch: agent tool registration order", () => {
  it("buildToolRegistry (read/write) emits tools in the exact pinned order", () => {
    const tools = buildToolRegistry(fakeCtx, { readOnly: false });
    const names = tools.map((t) => t.def.name);
    expect(names).toEqual([...TOOL_ORDER]);
  });

  it("buildToolRegistry (read-only) strips mutating provider + memory tools but keeps the rest in order", () => {
    const tools = buildToolRegistry(fakeCtx, { readOnly: true });
    const names = tools.map((t) => t.def.name);
    const STRIPPED_IN_READ_ONLY = new Set([
      "propose_transition",
      "propose_description_patch",
      "propose_comment",
      "propose_new_item",
      "propose_memory_write",
      "propose_memory_delete",
    ]);
    const stripped = TOOL_ORDER.filter((n) => !STRIPPED_IN_READ_ONLY.has(n));
    expect(names).toEqual(stripped);
  });

  it("every tool name is unique", () => {
    const tools = buildToolRegistry(fakeCtx, { readOnly: false });
    const names = tools.map((t) => t.def.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
