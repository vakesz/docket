import { describe, expect, it } from "vitest";
import { appendPreviousVersionFooter } from "@/server/proposals/builders";

describe("appendPreviousVersionFooter", () => {
  const NEW = "## Repro\n\nClick the foo button.";
  const PREV = "Some old description.";

  it("appends the previous body with author and date", () => {
    const out = appendPreviousVersionFooter(NEW, PREV, "alice", new Date("2026-04-15T12:34:00Z"));
    expect(out).toBe(`${NEW}\n\n---\n\n*Previous version (by alice, 2026-04-15):*\n\n${PREV}`);
  });

  it("falls back to date-only when author is null", () => {
    const out = appendPreviousVersionFooter(NEW, PREV, null, new Date("2026-04-15T00:00:00Z"));
    expect(out).toContain("*Previous version (2026-04-15):*");
    expect(out).toContain(PREV);
  });

  it("falls back to author-only when timestamp is null", () => {
    const out = appendPreviousVersionFooter(NEW, PREV, "alice", null);
    expect(out).toContain("*Previous version (by alice):*");
  });

  it("falls back to bare label when both author and timestamp are null", () => {
    const out = appendPreviousVersionFooter(NEW, PREV, null, null);
    expect(out).toContain("*Previous version:*");
    expect(out).not.toContain("(");
  });

  it("returns the new body unchanged when there is no previous content", () => {
    expect(appendPreviousVersionFooter(NEW, "", "alice", new Date())).toBe(NEW);
    expect(appendPreviousVersionFooter(NEW, "   \n\t", "alice", new Date())).toBe(NEW);
  });

  it("stacks linearly: a second patch wraps the first patch's footer", () => {
    const first = appendPreviousVersionFooter(
      "v2 body",
      "v1 body",
      "alice",
      new Date("2026-04-01T00:00:00Z"),
    );
    const second = appendPreviousVersionFooter(
      "v3 body",
      first,
      "bob",
      new Date("2026-04-15T00:00:00Z"),
    );
    expect(second.startsWith("v3 body")).toBe(true);
    // The v2 footer (with alice) survives nested inside the v3 footer (with bob).
    expect(second).toContain("*Previous version (by bob, 2026-04-15):*");
    expect(second).toContain("*Previous version (by alice, 2026-04-01):*");
    expect(second).toContain("v1 body");
    expect(second).toContain("v2 body");
  });

  it("trims trailing whitespace from the new body before the separator", () => {
    const out = appendPreviousVersionFooter(
      "new content\n\n   ",
      "old",
      "alice",
      new Date("2026-04-15T00:00:00Z"),
    );
    expect(out).toContain("new content\n\n---\n\n");
    expect(out).not.toContain("new content\n\n   \n\n---");
  });
});
