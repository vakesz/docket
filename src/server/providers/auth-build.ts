/**
 * Build a NextAuth `Provider` for an `OauthProviderConfig` row.
 *
 * Auth-side analogue of `./build.ts` — that file builds `WorkItemProvider`
 * instances at request time from a project's scope; this one builds NextAuth
 * provider configs at request time from the rows in `OauthProviderConfig`.
 * The dispatch goes through the registered spec's `buildAuthProvider`
 * factory, so concrete `next-auth/providers/<x>` imports stay inside each
 * provider package's `auth.ts` and adding a new OAuth kind is one new spec
 * entry — no edit here.
 *
 * Throws `UnknownOauthKindError` when `row.kind` doesn't match a registered
 * spec or when the matching spec has no auth factory wired. The caller in
 * `src/server/auth.ts` catches and logs so the sign-in page still renders
 * the remaining buttons.
 */

import "server-only";
import type { Provider } from "next-auth/providers";
import type { ProviderAuthInput } from "@/core/provider";
import type { OauthProviderConfig } from "@/db/schema/types";
import { asPlainObject } from "@/lib/json";
import { getProviderSpec } from "@/server/provider-registry";
import { decryptSecret } from "@/server/secrets/encryption";

export class UnknownOauthKindError extends Error {
  constructor(public readonly kind: string) {
    super(`Unknown OauthProviderConfig kind: '${kind}'`);
    this.name = "UnknownOauthKindError";
  }
}

export function buildAuthProvider(row: OauthProviderConfig): Provider {
  const spec = getProviderSpec(row.kind);
  if (!spec?.buildAuthProvider) {
    throw new UnknownOauthKindError(row.kind);
  }
  const input: ProviderAuthInput = {
    clientId: row.clientId,
    clientSecret: decryptSecret(row.clientSecret),
    scopes: row.scopes ? row.scopes : null,
    metadata: asPlainObject(row.metadata),
  };
  // The spec field is typed `unknown` so `core/` stays free of NextAuth.
  // The provider's `auth.ts` is type-checked against NextAuth's `Provider`
  // / `OIDCConfig` shapes at definition time, so this cast is safe here.
  return spec.buildAuthProvider(input) as Provider;
}
