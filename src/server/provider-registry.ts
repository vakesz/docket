import "server-only";
import type { ProviderSpec } from "@/core/provider";
import { azureDevOpsSpec } from "@/providers/azure-devops/spec";
import { githubSpec } from "@/providers/github/spec";

/**
 * Static registry of provider specs.
 *
 * Third-party providers add their spec to this tuple directly (or, if we
 * ever want a plugin shape, we'd add a build-time include). Tests use vi
 * mocks against `WorkItemProvider` instead of a stub provider.
 *
 * Each spec uses `satisfies ProviderSpec` so its `typeId` literal flows
 * through this `as const` tuple — `ProviderTypeId` and `PROVIDER_TYPE_IDS`
 * below are derived from it, so adding a provider only needs an entry here.
 */
export const PROVIDER_SPECS = [githubSpec, azureDevOpsSpec] as const;

export type ProviderTypeId = (typeof PROVIDER_SPECS)[number]["typeId"];

/**
 * Tuple of provider type ids derived from `PROVIDER_SPECS`. The asserted
 * non-empty-tuple shape lets `z.enum` consume it directly.
 */
export const PROVIDER_TYPE_IDS = PROVIDER_SPECS.map((s) => s.typeId) as unknown as readonly [
  ProviderTypeId,
  ...ProviderTypeId[],
];

export function getProviderSpec(typeId: string): ProviderSpec | null {
  return PROVIDER_SPECS.find((spec) => spec.typeId === typeId) ?? null;
}

export function listProviderSpecs(): readonly ProviderSpec[] {
  return PROVIDER_SPECS;
}
