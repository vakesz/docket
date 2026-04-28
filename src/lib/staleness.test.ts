import { describe, expect, it } from "vitest";
import { DEFAULT_STALE_THRESHOLD_DAYS, resolveEffectiveStaleThreshold } from "@/lib/staleness";

describe("resolveEffectiveStaleThreshold", () => {
  it("inherits the project value when the user override is the -1 sentinel", () => {
    expect(resolveEffectiveStaleThreshold(-1, 14)).toBe(14);
    expect(resolveEffectiveStaleThreshold(-1, 7)).toBe(7);
  });

  it("returns null (disabled) when the project value is 0 and user inherits", () => {
    expect(resolveEffectiveStaleThreshold(-1, 0)).toBeNull();
  });

  it("user-positive overrides a positive project value", () => {
    expect(resolveEffectiveStaleThreshold(30, 7)).toBe(30);
  });

  it("user-zero overrides a positive project value (disables for me)", () => {
    expect(resolveEffectiveStaleThreshold(0, 7)).toBeNull();
  });

  it("user-positive overrides project-zero (project disabled, I still see tints)", () => {
    expect(resolveEffectiveStaleThreshold(14, 0)).toBe(14);
  });

  it("falls back to the catalog default when both are nullish", () => {
    expect(resolveEffectiveStaleThreshold(null, null)).toBe(DEFAULT_STALE_THRESHOLD_DAYS);
    expect(resolveEffectiveStaleThreshold(undefined, undefined)).toBe(DEFAULT_STALE_THRESHOLD_DAYS);
  });

  it("ignores fractional user values and falls through to project", () => {
    // Math.trunc on the user-positive branch
    expect(resolveEffectiveStaleThreshold(14.7, 7)).toBe(14);
  });

  it("non-finite values fall through to the next layer", () => {
    expect(resolveEffectiveStaleThreshold(Number.NaN, 7)).toBe(7);
    expect(resolveEffectiveStaleThreshold(-1, Number.NaN)).toBe(DEFAULT_STALE_THRESHOLD_DAYS);
  });
});
