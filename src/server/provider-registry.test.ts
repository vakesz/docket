import { describe, expect, it } from "vitest";
import { getProviderSpec, listProviderSpecs, PROVIDER_SPECS } from "@/server/provider-registry";

describe("provider-registry", () => {
  it("ships GitHub at Phase 3; Azure DevOps lands at Phase 9", () => {
    expect(PROVIDER_SPECS.map((s) => s.typeId)).toEqual(["github"]);
    expect(listProviderSpecs()).toBe(PROVIDER_SPECS);
  });

  it("getProviderSpec returns null for unknown typeIds", () => {
    expect(getProviderSpec("anything")).toBeNull();
  });

  it("getProviderSpec resolves github to its spec", () => {
    const spec = getProviderSpec("github");
    expect(spec?.typeId).toBe("github");
    expect(spec?.displayName).toBe("GitHub");
  });
});
