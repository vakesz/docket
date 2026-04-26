import { describe, expect, it } from "vitest";
import { getProviderSpec, listProviderSpecs, PROVIDER_SPECS } from "@/server/provider-registry";

describe("provider-registry", () => {
  it("ships empty in Phase 1 — concrete specs land in Phase 3 (GitHub) and Phase 9 (AzDO)", () => {
    expect(PROVIDER_SPECS).toEqual([]);
    expect(listProviderSpecs()).toEqual([]);
  });

  it("getProviderSpec returns null for unknown typeIds", () => {
    expect(getProviderSpec("github")).toBeNull();
    expect(getProviderSpec("anything")).toBeNull();
  });
});
