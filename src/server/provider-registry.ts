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

export function getProviderSpec(typeId: string): ProviderSpec | null {
  return PROVIDER_SPECS.find((spec) => spec.typeId === typeId) ?? null;
}

export function listProviderSpecs(): readonly ProviderSpec[] {
  return PROVIDER_SPECS;
}
