import { describe, expect, it } from "vitest";
import { jaccardSimilarity, scoreItemPair, tokenize } from "@/server/recommendations/similarity";

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumeric, drops short tokens", () => {
    const tokens = tokenize("Fix Memory Leak in Worker-Pool!");
    expect(tokens.has("fix")).toBe(true);
    expect(tokens.has("memory")).toBe(true);
    expect(tokens.has("leak")).toBe(true);
    expect(tokens.has("worker")).toBe(true);
    expect(tokens.has("pool")).toBe(true);
    // "in" is filtered (length < 3)
    expect(tokens.has("in")).toBe(false);
  });

  it("keeps numeric / mixed tokens of length 3+", () => {
    const tokens = tokenize("v123 abc12 ok");
    expect(tokens.has("v123")).toBe(true);
    expect(tokens.has("abc12")).toBe(true);
    // "ok" filtered
    expect(tokens.has("ok")).toBe(false);
  });

  it("dedupes via Set semantics", () => {
    const tokens = tokenize("foo foo foo bar");
    expect(tokens.size).toBe(2);
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical inputs", () => {
    expect(jaccardSimilarity("memory leak in worker", "memory leak in worker")).toBe(1);
  });

  it("returns 0 for disjoint token sets", () => {
    expect(jaccardSimilarity("alpha beta gamma", "delta epsilon zeta")).toBe(0);
  });

  it("returns 0 when either side tokenizes to empty", () => {
    expect(jaccardSimilarity("", "anything goes here")).toBe(0);
    expect(jaccardSimilarity("a b c", "anything goes here")).toBe(0); // a/b/c filtered
  });

  it("computes the overlap ratio between partial matches", () => {
    // tokens: {memory, leak, worker} vs {memory, leak, fix}
    // intersection 2, union 4 → 0.5
    const score = jaccardSimilarity("memory leak in worker", "memory leak fix");
    expect(score).toBeCloseTo(0.5, 5);
  });
});

describe("scoreItemPair", () => {
  it("blends title + description into a single token bag", () => {
    const a = { title: "Worker pool memory leak", description: "Heap grows unbounded." };
    const b = { title: "Memory leak", description: "Worker pool heap unbounded." };
    const score = scoreItemPair(a, b);
    // Should be high because the two halves overlap heavily once flattened.
    expect(score).toBeGreaterThan(0.5);
  });

  it("returns 0 for genuinely unrelated items", () => {
    const a = { title: "Alpha", description: "Beta gamma." };
    const b = { title: "Delta", description: "Epsilon zeta." };
    expect(scoreItemPair(a, b)).toBe(0);
  });
});
