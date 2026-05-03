import { describe, expect, it } from "vitest";
import {
  buildSystemPrefix,
  DEFAULT_KIND_PROMPTS,
  DEFAULT_PROMPTS,
  DEFAULT_SYSTEM_BASE,
  PR_TOOLS_BUG_GUIDANCE,
  PR_TOOLS_SYSTEM_GUIDANCE,
  toolRoundsBudgetLine,
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
    expect(withSummary.startsWith(withoutSummary)).toBe(true);
    expect(withSummary).toContain(DEFAULT_KIND_PROMPTS[kind]);
  });

  describe("capability gating", () => {
    it("omits PR tool guidance when no capabilities are supplied", () => {
      const out = buildSystemPrefix({ itemKind: null, itemSummary: null });
      expect(out).not.toContain(PR_TOOLS_SYSTEM_GUIDANCE);
    });

    it("omits PR tool guidance when pullRequestDiffs is false", () => {
      const out = buildSystemPrefix({
        itemKind: null,
        itemSummary: null,
        capabilities: { pullRequestDiffs: false },
      });
      expect(out).not.toContain(PR_TOOLS_SYSTEM_GUIDANCE);
    });

    it("includes PR tool guidance after the system base when pullRequestDiffs is true", () => {
      const out = buildSystemPrefix({
        itemKind: null,
        itemSummary: null,
        capabilities: { pullRequestDiffs: true },
      });
      expect(out).toBe(`${DEFAULT_SYSTEM_BASE}\n\n${PR_TOOLS_SYSTEM_GUIDANCE}`);
    });

    it("appends PR-specific bug guidance after the bug kind prompt when pullRequestDiffs is true", () => {
      const out = buildSystemPrefix({
        itemKind: "bug",
        itemSummary: null,
        capabilities: { pullRequestDiffs: true },
      });
      expect(out.endsWith(PR_TOOLS_BUG_GUIDANCE)).toBe(true);
      expect(out).toContain(`${DEFAULT_KIND_PROMPTS.bug}\n\n${PR_TOOLS_BUG_GUIDANCE}`);
    });

    it("does NOT append PR bug guidance for non-bug kinds even when pullRequestDiffs is true", () => {
      const out = buildSystemPrefix({
        itemKind: "story",
        itemSummary: null,
        capabilities: { pullRequestDiffs: true },
      });
      expect(out).not.toContain(PR_TOOLS_BUG_GUIDANCE);
    });

    it("keeps the item-summary tail after capability addenda for stable ordering", () => {
      const out = buildSystemPrefix({
        itemKind: "bug",
        itemSummary: ITEM_SUMMARY,
        capabilities: { pullRequestDiffs: true },
      });
      const summarySection = `Item under discussion:\n${ITEM_SUMMARY}`;
      expect(out.endsWith(summarySection)).toBe(true);
      const summaryIdx = out.indexOf(summarySection);
      const bugAddendumIdx = out.indexOf(PR_TOOLS_BUG_GUIDANCE);
      expect(bugAddendumIdx).toBeGreaterThan(-1);
      expect(summaryIdx).toBeGreaterThan(bugAddendumIdx);
    });
  });

  describe("tool-call budget", () => {
    it("omits the budget block when maxToolRounds is undefined", () => {
      const out = buildSystemPrefix({ itemKind: null, itemSummary: null });
      expect(out).not.toContain("Tool-call budget");
    });

    it("appends the budget block right after the system base when maxToolRounds is set", () => {
      const out = buildSystemPrefix({
        itemKind: null,
        itemSummary: null,
        maxToolRounds: 12,
      });
      expect(out).toBe(`${DEFAULT_SYSTEM_BASE}\n\n${toolRoundsBudgetLine(12)}`);
    });

    it("interpolates the cap value into the budget line", () => {
      const out = buildSystemPrefix({
        itemKind: null,
        itemSummary: null,
        maxToolRounds: 4,
      });
      expect(out).toContain("at most 4 tool-call rounds per turn");
    });

    it("places the budget block before capability + kind addenda", () => {
      const out = buildSystemPrefix({
        itemKind: "bug",
        itemSummary: ITEM_SUMMARY,
        capabilities: { pullRequestDiffs: true },
        maxToolRounds: 8,
      });
      const budgetIdx = out.indexOf(toolRoundsBudgetLine(8));
      const prGuidanceIdx = out.indexOf(PR_TOOLS_SYSTEM_GUIDANCE);
      const bugKindIdx = out.indexOf(DEFAULT_KIND_PROMPTS.bug);
      const summaryIdx = out.indexOf(`Item under discussion:\n${ITEM_SUMMARY}`);
      expect(budgetIdx).toBeGreaterThan(-1);
      expect(prGuidanceIdx).toBeGreaterThan(budgetIdx);
      expect(bugKindIdx).toBeGreaterThan(prGuidanceIdx);
      expect(summaryIdx).toBeGreaterThan(bugKindIdx);
    });

    it("is byte-stable for the same cap and varies only when the cap changes", () => {
      const a = buildSystemPrefix({ itemKind: "story", itemSummary: null, maxToolRounds: 12 });
      const b = buildSystemPrefix({ itemKind: "story", itemSummary: null, maxToolRounds: 12 });
      const c = buildSystemPrefix({ itemKind: "story", itemSummary: null, maxToolRounds: 6 });
      expect(a).toBe(b);
      expect(a).not.toBe(c);
    });
  });
});
