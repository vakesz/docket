import "server-only";
import type { ProviderSpec } from "@/core/provider";

/**
 * Static registry of provider specs.
 *
 * Replaces the Python tree's `providers/registry.py`, which discovered
 * providers via the `docket.providers` entry-point group. TS imports are
 * static — third-party providers add their spec to this array directly
 * (or, if we ever want a plugin shape, we'd add a build-time include).
 *
 * Phase 1 ships an empty array. Phase 3 adds the GitHub spec; Phase 9 adds
 * Azure DevOps. The github_stub provider is dropped — tests use vi mocks
 * against `WorkItemProvider` instead.
 */
export const PROVIDER_SPECS: readonly ProviderSpec[] = [];

export function getProviderSpec(typeId: string): ProviderSpec | null {
  return PROVIDER_SPECS.find((spec) => spec.typeId === typeId) ?? null;
}

export function listProviderSpecs(): readonly ProviderSpec[] {
  return PROVIDER_SPECS;
}
