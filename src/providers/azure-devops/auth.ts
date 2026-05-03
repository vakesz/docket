// Microsoft deprecated the legacy `app.vssps.visualstudio.com/oauth2/*`
// flow (the one NextAuth ships as `azure-devops`); the supported path is
// Microsoft Entra ID with `<resource>/.default` against the AzDO API
// resource id Microsoft publishes in their OAuth docs. We don't bake the
// id into source — it rides in `OauthProviderConfig.metadata.resourceId`
// (DB-authoritative, seeded from `DEV_AZURE_DEVOPS_RESOURCE_ID` on first
// boot by `bin/bootstrap-providers.ts`).
//
// Provider id `azure_devops` must match `OauthProviderConfig.kind` and
// `Project.providerKind` — the NextAuth `Account.provider` column has to
// line up with what `buildProviderForUser` looks up. Load-bearing
// symmetry; change one side, change both.

import "server-only";
import type { OIDCConfig } from "next-auth/providers";
import type { ProviderAuthInput } from "@/core/provider";
import type { UserId } from "@/core/types";
import { db } from "@/db";
import { avatarUrl } from "@/lib/avatar-url";
import { fetchAvatarFromProvider } from "@/server/avatars/fetchers";
import { persistAvatar } from "@/server/avatars/service";
import { logger } from "@/server/logger";

function readStringMeta(metadata: Record<string, unknown>, key: string): string | undefined {
  const v = metadata[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function requireAzdoResourceId(metadata: Record<string, unknown>): string {
  const raw = readStringMeta(metadata, "resourceId")?.trim();
  if (!raw) {
    throw new Error(
      "Azure DevOps OAuth row is missing metadata.resourceId. Seed it via DEV_AZURE_DEVOPS_RESOURCE_ID in env on first boot, or set it from the OAuth provider admin UI.",
    );
  }
  return raw;
}

/**
 * Fetch the signed-in user's avatar via the shared fetcher, write the bytes
 * into the `Avatar` cache keyed by the same identifier `Item.assignee`
 * carries for AzDO work items (the Entra `preferred_username`, which is
 * the email-shaped `uniqueName` AzDO stamps onto AssignedTo). Returns the
 * relative `/api/avatars/...` URL the UI should render — bytes flow
 * through our route handler so the User row no longer carries a base64
 * data URL.
 */
async function captureAzureDevOpsAvatar(
  identifier: string,
  accessToken: string | undefined,
): Promise<void> {
  if (!accessToken) return;
  try {
    const fetched = await fetchAvatarFromProvider("azure_devops", identifier, {
      accessToken,
      isSelf: true,
    });
    await persistAvatar(db, {
      providerKind: "azure_devops",
      identifier,
      bytes: fetched?.bytes ?? null,
      contentType: fetched?.contentType ?? null,
      etag: fetched?.etag ?? null,
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "azure-devops: avatar capture failed; route will surface 404 until next sign-in",
    );
  }
}

/**
 * Profile shape Entra ID returns at the userinfo endpoint. Trimmed to what
 * NextAuth's `profile` callback needs to map onto a User row.
 */
export interface AzureDevOpsEntraProfile {
  sub: string;
  name?: string;
  email?: string;
  preferred_username?: string;
  oid?: string;
}

/**
 * Spec-side `buildAuthProvider` for Azure DevOps. The dispatcher hands
 * `ProviderAuthInput` with metadata.tenant carrying the Entra tenant id and
 * `scopes` carrying any extra scopes the operator added on top of the
 * required AzDO `.default` baseline.
 */
export function buildAzureDevOpsAuthProvider(
  input: ProviderAuthInput,
): OIDCConfig<AzureDevOpsEntraProfile> {
  const tenantRaw = readStringMeta(input.metadata, "tenant");
  const tenant = tenantRaw?.trim() ? tenantRaw.trim() : "common";
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
  const resourceId = requireAzdoResourceId(input.metadata);
  const baseScope = `openid profile email offline_access ${resourceId}/.default`;
  const scope = input.scopes ? `${baseScope} ${input.scopes}` : baseScope;
  return {
    id: "azure_devops",
    name: "Azure DevOps",
    type: "oidc",
    issuer,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    authorization: { params: { scope } },
    // The Microsoft userinfo response uses `oid` for stable user id and
    // `preferred_username` for the email-shaped UPN; fall back to `sub`
    // (always present) so we never end up with a null id.
    //
    // Entra's userinfo doesn't include a photo, so we hop to the AzDO
    // Profile API at sign-in time using the access token we just issued.
    // Same lifecycle as GitHub: captured once, refreshed on the next sign-in.
    //
    // Avatar identifier intentionally uses `preferred_username` (the
    // email-shaped UPN) rather than `oid` — that's what AzDO stamps into
    // `System.AssignedTo.uniqueName` on work items, and the assignee chip
    // renders avatars via that same identifier. Aligning the two means the
    // signed-in user's chip and the account-menu button hit the same row.
    async profile(profile, tokens) {
      const identifier = profile.preferred_username ?? profile.email ?? profile.oid ?? profile.sub;
      const accessToken = tokens?.access_token;
      if (identifier && accessToken) {
        await captureAzureDevOpsAvatar(identifier, accessToken);
      }
      return {
        id: (profile.oid || profile.sub) as UserId,
        name: profile.name ?? null,
        email: profile.email ?? profile.preferred_username ?? null,
        image: identifier ? avatarUrl("azure_devops", identifier) : null,
      };
    },
  };
}
