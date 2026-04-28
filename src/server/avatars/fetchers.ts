/**
 * Per-providerKind HTTP fetchers for profile pictures.
 *
 * Each fetcher returns either fresh image bytes + content-type or `null`
 * when the provider has confirmed nothing is available (e.g. 404). Network
 * errors bubble up as thrown exceptions — the caller decides whether to
 * stamp a transient failure or retry.
 *
 * The fetchers are intentionally not part of the `WorkItemProvider`
 * interface. Avatar lookup isn't a project-scoped operation (the same
 * person resolves the same way across every project of that provider
 * kind), and not every provider has a useful fetcher — GitHub has a public
 * CDN for every login, AzDO can only fetch the *signed-in user's* avatar
 * cheaply. Each spec exposes its own fetcher via `ProviderSpec.avatarFetcher`
 * (or `null` to opt out) and this module dispatches via the registry so
 * adding a new provider is one new file in `src/providers/<x>/avatar.ts`.
 */

import "server-only";
import { getProviderSpec } from "@/server/provider-registry";

export type FetchedAvatar = {
  bytes: Uint8Array;
  contentType: string;
  etag?: string | null;
};

export type FetchAvatarOptions = {
  /** Bearer token; required for AzDO, ignored by the public GitHub fetcher. */
  accessToken?: string | null;
  /**
   * True when the identifier matches the signed-in user's identity. AzDO
   * only exposes a cheap fetch for "me"; cross-user lookup needs an
   * Identities-API hop we haven't wired, so the fetcher returns null for
   * non-self identifiers and the UI keeps showing initials.
   */
  isSelf?: boolean;
};

export async function fetchAvatarFromProvider(
  providerKind: string,
  identifier: string,
  opts: FetchAvatarOptions = {},
): Promise<FetchedAvatar | null> {
  const spec = getProviderSpec(providerKind);
  if (!spec?.avatarFetcher) return null;
  return spec.avatarFetcher(identifier, opts);
}
