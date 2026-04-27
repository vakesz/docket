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
import { azureDevOpsProvider } from "@/providers/azure-devops/auth";
import { decryptSecret } from "@/server/secrets/encryption";

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
