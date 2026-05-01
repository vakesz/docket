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
 * Non-empty tuple of provider type ids derived from `PROVIDER_SPECS`. Built
 * head-then-tail so the result type is `[ProviderTypeId, ...ProviderTypeId[]]`
 * without needing an `unknown`-cast bridge — the `[0]` index access is
 * checked at the type level by `noUncheckedIndexedAccess` plus the runtime
 * guard below, which is fine because `PROVIDER_SPECS` is an `as const` tuple
 * with two static entries.
 */
const [firstSpec, ...restSpecs] = PROVIDER_SPECS;
export const PROVIDER_TYPE_IDS: readonly [ProviderTypeId, ...ProviderTypeId[]] = [
  firstSpec.typeId,
  ...restSpecs.map((s) => s.typeId),
];

export function getProviderSpec(typeId: string): ProviderSpec | null {
  return PROVIDER_SPECS.find((spec) => spec.typeId === typeId) ?? null;
}

export function listProviderSpecs(): readonly ProviderSpec[] {
  return PROVIDER_SPECS;
}
