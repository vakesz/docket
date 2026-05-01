import { describe, expect, it } from "vitest";
import {
  buildSystemPrefix,
  DEFAULT_KIND_PROMPTS,
  DEFAULT_PROMPTS,
  DEFAULT_SYSTEM_BASE,
} from "@/agent/prompt";
import type { ItemKind } from "@/core/types";

const ITEM_SUMMARY = [
  "id: 123",
  "kind: bug",
  "title: example title",
  "state: in_progress",
  "assignee: alice",
].join("\n");

describe("buildSystemPrefix", () => {
  it("starts with the system base when no kind is supplied", () => {
    const out = buildSystemPrefix({ itemKind: null, itemSummary: null });
    expect(out).toBe(DEFAULT_SYSTEM_BASE);
  });

  it("appends the kind prompt when itemKind is set", () => {
    const out = buildSystemPrefix({ itemKind: "bug", itemSummary: null });
    expect(out.startsWith(DEFAULT_SYSTEM_BASE)).toBe(true);
    expect(out.endsWith(DEFAULT_KIND_PROMPTS.bug)).toBe(true);
  });

  it("appends the item summary block when supplied", () => {
    const out = buildSystemPrefix({ itemKind: "bug", itemSummary: ITEM_SUMMARY });
    expect(out.endsWith(`Item under discussion:\n${ITEM_SUMMARY}`)).toBe(true);
  });

  it("is byte-stable across repeated calls (no timestamps / randomness)", () => {
    const a = buildSystemPrefix({ itemKind: "story", itemSummary: ITEM_SUMMARY });
    const b = buildSystemPrefix({ itemKind: "story", itemSummary: ITEM_SUMMARY });
    expect(a).toBe(b);
  });

  it("uses the supplied prompts override instead of the bundled defaults", () => {
    const out = buildSystemPrefix({
      itemKind: "epic",
      itemSummary: null,
      prompts: {
        systemBase: "OVERRIDE BASE",
        kindPrompts: { ...DEFAULT_KIND_PROMPTS, epic: "OVERRIDE EPIC" },
      },
    });
    expect(out).toBe("OVERRIDE BASE\n\nOVERRIDE EPIC");
  });

  it("falls back to bundled defaults when no prompts override is given", () => {
    const out = buildSystemPrefix({ itemKind: "task", itemSummary: null });
    const expected = `${DEFAULT_PROMPTS.systemBase}\n\n${DEFAULT_PROMPTS.kindPrompts.task}`;
    expect(out).toBe(expected);
  });

  it.each([
    "epic",
    "feature",
    "story",
    "task",
    "bug",
  ] satisfies readonly ItemKind[])("renders %s prefix permutation deterministically", (kind) => {
    const withSummary = buildSystemPrefix({ itemKind: kind, itemSummary: ITEM_SUMMARY });
    const withoutSummary = buildSystemPrefix({ itemKind: kind, itemSummary: null });
    // With-summary output must include without-summary output as a strict prefix.
    expect(withSummary.startsWith(withoutSummary)).toBe(true);
    expect(withSummary).toContain(DEFAULT_KIND_PROMPTS[kind]);
  });
});
