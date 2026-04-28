import "server-only";
import type { ProviderSpec } from "@/core/provider";
import { azureDevOpsSpec } from "@/providers/azure-devops/spec";
import { githubSpec } from "@/providers/github/spec";

/**
 * Static registry of provider specs.
 *
 * Third-party providers add their spec to this array directly (or, if we
 * ever want a plugin shape, we'd add a build-time include). Tests use vi
 * mocks against `WorkItemProvider` instead of a stub provider.
 */
export const PROVIDER_SPECS: readonly ProviderSpec[] = [githubSpec, azureDevOpsSpec];

/**
 * Const tuple of provider type ids, kept in sync with `PROVIDER_SPECS`. The
 * `as const` narrowing lets `z.enum` consume it directly without an unsafe
 * cast — adding a provider here is a compile error if the spec doesn't match.
 */
export const PROVIDER_TYPE_IDS = ["github", "azure_devops"] as const;
export type ProviderTypeId = (typeof PROVIDER_TYPE_IDS)[number];

if (
  PROVIDER_SPECS.length !== PROVIDER_TYPE_IDS.length ||
  PROVIDER_SPECS.some((s, i) => s.typeId !== PROVIDER_TYPE_IDS[i])
) {
  throw new Error(
    `provider-registry: PROVIDER_TYPE_IDS drift; got [${PROVIDER_SPECS.map((s) => s.typeId).join(", ")}], expected [${PROVIDER_TYPE_IDS.join(", ")}]`,
  );
}

export function getProviderSpec(typeId: string): ProviderSpec | null {
  return PROVIDER_SPECS.find((spec) => spec.typeId === typeId) ?? null;
}

export function listProviderSpecs(): readonly ProviderSpec[] {
  return PROVIDER_SPECS;
}
