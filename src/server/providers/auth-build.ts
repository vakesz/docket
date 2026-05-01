/**
 * Build a NextAuth `Provider` for an `OauthProviderConfig` row.
 *
 * Auth-side analogue of `./build.ts` — that file builds `WorkItemProvider`
 * instances at request time from a project's scope; this one builds NextAuth
 * provider configs at request time from the rows in `OauthProviderConfig`.
 * The dispatch is a pure switch — concrete `next-auth/providers/<x>`
 * imports live inside each provider package's `auth.ts`, so adding a new
 * OAuth kind doesn't touch this file beyond one new `case`.
 *
 * Throws `UnknownOauthKindError` when `row.kind` doesn't match a wired
 * adapter. The caller in `src/server/auth.ts` catches and logs so the
 * sign-in page still renders the remaining buttons.
 */

import "server-only";
import type { Provider } from "next-auth/providers";
import type { OauthProviderConfig } from "@/db/generated/client";
import { asPlainObject } from "@/lib/json";
import { azureDevOpsProvider } from "@/providers/azure-devops/auth";
import { githubAuthProvider } from "@/providers/github/auth";
import { decryptSecret } from "@/server/secrets/encryption";

export class UnknownOauthKindError extends Error {
  constructor(public readonly kind: string) {
    super(`Unknown OauthProviderConfig kind: '${kind}'`);
    this.name = "UnknownOauthKindError";
  }
}

function readStringMeta(metadata: unknown, key: string): string | undefined {
  const obj = asPlainObject(metadata);
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function buildAuthProvider(row: OauthProviderConfig): Provider {
  // `clientSecret` is encrypted at rest with `SECRETS_KEY`. Legacy plaintext
  // rows are returned as-is by `decryptSecret`, so this is a no-op until the
  // operator rolls a key.
  const clientSecret = decryptSecret(row.clientSecret);
  switch (row.kind) {
    case "github":
      return githubAuthProvider({
        clientId: row.clientId,
        clientSecret,
        scopes: row.scopes,
      });
    case "azure_devops": {
      // Entra tenant id lives under `metadata.tenant`. The legacy `baseUrl`
      // slot is read as a fallback so a row that hasn't been migrated yet
      // (between `prisma db push` and `bin/apply-raw-sql.ts`) still resolves.
      // Empty → multi-tenant `common` endpoint.
      const tenant = readStringMeta(row.metadata, "tenant") ?? row.baseUrl;
      return azureDevOpsProvider({
        clientId: row.clientId,
        clientSecret,
        ...(tenant ? { tenant } : {}),
        ...(row.scopes ? { extraScope: row.scopes } : {}),
      });
    }
    default:
      throw new UnknownOauthKindError(row.kind);
  }
}
