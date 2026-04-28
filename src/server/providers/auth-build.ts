/**
 * Build a NextAuth `Provider` for an `OauthProviderConfig` row.
 *
 * This is the auth-side analogue of `./build.ts` — that file builds
 * `WorkItemProvider` instances at request time from a project's scope; this
 * one builds NextAuth provider configs at request time from the rows in
 * `OauthProviderConfig`. Centralizing the dispatch here keeps
 * `src/server/auth.ts` clean of concrete provider imports (the arch test
 * allows this file alongside `build.ts` and `provider-registry.ts`).
 *
 * Returns `null` for an unknown `kind` so the caller can log + skip rather
 * than blow up the whole sign-in page when the database carries a row from
 * a yet-to-be-implemented provider.
 */

import "server-only";
import type { Provider } from "next-auth/providers";
import GitHub from "next-auth/providers/github";
import type { OauthProviderConfig } from "@/db/generated/client";
import { avatarUrl } from "@/lib/avatar-url";
import { azureDevOpsProvider } from "@/providers/azure-devops/auth";
import { fetchAvatarFromProvider } from "@/server/avatars/fetchers";
import { persistAvatar } from "@/server/avatars/service";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { decryptSecret } from "@/server/secrets/encryption";

/**
 * GitHub returns the OAuth profile shape NextAuth's built-in provider maps
 * onto a User row. We override the `profile` callback so we can intercept
 * the avatar URL, fetch the bytes ourselves, write them to the `Avatar`
 * cache, and rewrite `image` to point at our own `/api/avatars/...` route
 * — that way the rest of the app reads avatars from a single source of
 * truth and we drop the cross-origin hot-link to `avatars.githubusercontent.com`.
 */
type GitHubProfile = {
  id: number | string;
  name?: string | null;
  email?: string | null;
  login: string;
  avatar_url?: string | null;
};

export function buildAuthProvider(row: OauthProviderConfig): Provider | null {
  // `clientSecret` is encrypted at rest with `SECRETS_KEY`. Legacy plaintext
  // rows are returned as-is by `decryptSecret`, so this is a no-op until the
  // operator rolls a key.
  const clientSecret = decryptSecret(row.clientSecret);
  switch (row.kind) {
    case "github":
      return GitHub({
        clientId: row.clientId,
        clientSecret,
        // GitHub's NextAuth provider derives scopes from the default
        // authorization URL; if the row carries an override, splice it in.
        ...(row.scopes ? { authorization: { params: { scope: row.scopes } } } : {}),
        async profile(profile: GitHubProfile) {
          const login = profile.login;
          const image = login ? await captureAvatarBytes("github", login) : null;
          return {
            id: String(profile.id),
            name: profile.name ?? login ?? null,
            email: profile.email ?? null,
            image,
          };
        },
      });
    case "azure_devops":
      // Tenant id rides in the `baseUrl` column for now — the schema's
      // existing override slot is exactly the right shape (per-row,
      // optional, free-form string) and avoids an Entra-only schema bump.
      // Empty string → multi-tenant `common` endpoint.
      return azureDevOpsProvider({
        clientId: row.clientId,
        clientSecret,
        tenant: row.baseUrl || undefined,
        extraScope: row.scopes || undefined,
      });
    default:
      return null;
  }
}

/**
 * Best-effort: pull the bytes from the public fetcher, stash them in the
 * `Avatar` cache, and return the relative URL the UI should render. If the
 * provider 404s or the network blows up, we still return the URL — the
 * route handler will surface a 404 and the UI's `onError` falls back to an
 * initial chip.
 */
async function captureAvatarBytes(providerKind: string, identifier: string): Promise<string> {
  try {
    const fetched = await fetchAvatarFromProvider(providerKind, identifier);
    await persistAvatar(db, {
      providerKind,
      identifier,
      bytes: fetched?.bytes ?? null,
      contentType: fetched?.contentType ?? null,
      etag: fetched?.etag ?? null,
    });
  } catch (err) {
    logger.warn(
      {
        providerKind,
        identifier,
        err: err instanceof Error ? err.message : String(err),
      },
      "auth: avatar capture failed; route will surface 404 until next sign-in",
    );
  }
  return avatarUrl(providerKind, identifier);
}

export { captureAvatarBytes };
