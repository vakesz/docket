import { describe, expect, it } from "vitest";
import { getProviderSpec, listProviderSpecs, PROVIDER_SPECS } from "@/server/provider-registry";

describe("provider-registry", () => {
  it("exposes GitHub and Azure DevOps in registration order", () => {
    expect(PROVIDER_SPECS.map((s) => s.typeId)).toEqual(["github", "azure_devops"]);
    expect(listProviderSpecs()).toBe(PROVIDER_SPECS);
  });

  it("getProviderSpec resolves azure_devops to its spec", () => {
    const spec = getProviderSpec("azure_devops");
    expect(spec?.typeId).toBe("azure_devops");
    expect(spec?.displayName).toBe("Azure DevOps");
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
