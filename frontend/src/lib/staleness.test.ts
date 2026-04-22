import { describe, expect, test } from "bun:test";

import { ageDays, freshnessTone, resolveStaleThreshold } from "./staleness";

describe("resolveStaleThreshold", () => {
  test("falls back to the default threshold", () => {
    expect(resolveStaleThreshold(undefined)).toBe(7);
    expect(resolveStaleThreshold({})).toBe(7);
  });

  test("prefers a provider override when present", () => {
    expect(
      resolveStaleThreshold(
        {
          stale: {
            threshold_days: 30,
            threshold_days_by_provider: {
              github: 5,
            },
          },
        },
        "github",
      ),
    ).toBe(5);
  });

  test("treats zero as disabled", () => {
    expect(
      resolveStaleThreshold(
        {
          stale: {
            threshold_days: 0,
          },
        },
        "github",
      ),
    ).toBeNull();
  });
});

describe("freshnessTone", () => {
  const now = Date.parse("2026-04-22T12:00:00Z");

  test("uses whole-day age buckets", () => {
    expect(ageDays("2026-04-15T12:00:00Z", now)).toBe(7);
    expect(ageDays("2026-04-08T12:00:00Z", now)).toBe(14);
  });

  test("marks warning once the threshold is reached", () => {
    expect(freshnessTone("2026-04-15T12:00:00Z", 7, now)).toBe("warning");
  });

  test("marks stale once the age doubles the threshold", () => {
    expect(freshnessTone("2026-04-08T12:00:00Z", 7, now)).toBe("stale");
  });

  test("stays fresh when the threshold is disabled or the timestamp is missing", () => {
    expect(freshnessTone("2026-04-21T12:00:00Z", null, now)).toBe("fresh");
    expect(freshnessTone(null, 7, now)).toBe("fresh");
  });
});
