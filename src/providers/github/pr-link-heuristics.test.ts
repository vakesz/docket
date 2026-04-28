import { describe, expect, it } from "vitest";
import type { PRMatch } from "@/core/types";
import {
  bodyHasClosingKeyword,
  branchMatchesIssue,
  CONFIDENCE_BRANCH_NAME,
  CONFIDENCE_SEARCH_TITLE,
  CONFIDENCE_TIMELINE_CLOSING,
  CONFIDENCE_TIMELINE_MENTION,
  MAX_MATCHES,
  mergeMatches,
  titleMentionsIssue,
} from "@/providers/github/pr-link-heuristics";

describe("bodyHasClosingKeyword", () => {
  it.each([
    ["Fixes #4538", true],
    ["fixes #4538", true],
    ["fixed #4538", true],
    ["fix #4538", true],
    ["Closes #4538", true],
    ["closed 4538", true],
    ["Resolves GH-4538", true],
    ["See #4538 for context", false],
    ["fixes #45", false],
    ["fixes #45380", false],
  ])("%s -> %s", (body, expected) => {
    expect(bodyHasClosingKeyword(body, 4538)).toBe(expected);
  });

  it("matches when keyword is one of several references", () => {
    const body = "Related: #1234. Also fixes #4538 finally.";
    expect(bodyHasClosingKeyword(body, 4538)).toBe(true);
    expect(bodyHasClosingKeyword(body, 1234)).toBe(false);
  });
});

describe("branchMatchesIssue", () => {
  it.each([
    ["fix/4538", true],
    ["issue-4538", true],
    ["4538-skip-oauth-modal", true],
    ["gh-4538", true],
    ["fix-4538-and-more", true],
    ["pr-453", false],
    ["45380-something", false],
    ["main", false],
  ])("%s -> %s", (branch, expected) => {
    expect(branchMatchesIssue(branch, 4538)).toBe(expected);
  });
});

describe("titleMentionsIssue", () => {
  it("matches #N references in titles", () => {
    expect(titleMentionsIssue("Skip oauth modal (#4538)", 4538)).toBe(true);
    expect(titleMentionsIssue("Fix GH-4538", 4538)).toBe(true);
    expect(titleMentionsIssue("Refactor login flow", 4538)).toBe(false);
    expect(titleMentionsIssue("Touches #45380", 4538)).toBe(false);
  });
});

describe("mergeMatches", () => {
  const sample = (over: Partial<PRMatch>): PRMatch => ({
    url: "https://github.com/o/r/pull/1",
    title: "t",
    branch: "",
    state: "open",
    author: "a",
    confidence: 0.5,
    ...over,
  });

  it("dedupes by url, keeping the highest confidence", () => {
    const out = mergeMatches([
      sample({ url: "u1", confidence: 0.4 }),
      sample({ url: "u1", confidence: 0.95 }),
      sample({ url: "u2", confidence: 0.6 }),
    ]);
    expect(out).toHaveLength(2);
    const u1 = out.find((m) => m.url === "u1");
    expect(u1?.confidence).toBe(0.95);
  });

  it("sorts by confidence desc, then merged > open > closed", () => {
    const out = mergeMatches([
      sample({ url: "a", confidence: 0.7, state: "closed" }),
      sample({ url: "b", confidence: 0.7, state: "merged" }),
      sample({ url: "c", confidence: 0.7, state: "open" }),
      sample({ url: "d", confidence: 0.95, state: "open" }),
    ]);
    expect(out.map((m) => m.url)).toEqual(["d", "b", "c", "a"]);
  });

  it(`caps results at ${MAX_MATCHES}`, () => {
    const many: PRMatch[] = Array.from({ length: MAX_MATCHES + 5 }, (_, i) =>
      sample({ url: `u${i}`, confidence: 0.5 + i * 0.001 }),
    );
    expect(mergeMatches(many)).toHaveLength(MAX_MATCHES);
  });

  it("preserves expected confidence band ordering across signals", () => {
    const out = mergeMatches([
      sample({ url: "branch", confidence: CONFIDENCE_BRANCH_NAME }),
      sample({ url: "search", confidence: CONFIDENCE_SEARCH_TITLE }),
      sample({ url: "timeline-mention", confidence: CONFIDENCE_TIMELINE_MENTION }),
      sample({ url: "timeline-closing", confidence: CONFIDENCE_TIMELINE_CLOSING }),
    ]);
    expect(out.map((m) => m.url)).toEqual([
      "timeline-closing",
      "timeline-mention",
      "search",
      "branch",
    ]);
  });
});
