// Microsoft deprecated the legacy `app.vssps.visualstudio.com/oauth2/*`
// flow (the one NextAuth ships as `azure-devops`); the supported path is
// Microsoft Entra ID with `.default` against AzDO resource id
// `499b84ac-1321-427f-aa17-267ca6975798`.
//
// Provider id `azure_devops` must match `OauthProviderConfig.kind` and
// `Project.providerKind` — the NextAuth `Account.provider` column has to
// line up with what `buildProviderForUser` looks up. Load-bearing
// symmetry; change one side, change both.

import "server-only";
import type { OIDCConfig } from "next-auth/providers";
import { db } from "@/db";
import { avatarUrl } from "@/lib/avatar-url";
import { fetchAvatarFromProvider } from "@/server/avatars/fetchers";
import { persistAvatar } from "@/server/avatars/service";
import { logger } from "@/server/logger";

const AZDO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

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

export type AzureDevOpsAuthOptions = {
  clientId: string;
  clientSecret: string;
  /**
   * Entra tenant id, or "common" / "organizations" / "consumers" for the
   * multi-tenant endpoints. When unset we default to "common", which lets
   * any AAD or Microsoft account in.
   */
  tenant?: string;
  /**
   * Extra scopes to request alongside the AzDO `.default` scope.
   * `offline_access` triggers refresh-token issuance; OIDC scopes
   * (`openid profile email`) populate the userinfo response so the
   * NextAuth user row has a name + email.
   */
  extraScope?: string;
};

export function azureDevOpsProvider(
  opts: AzureDevOpsAuthOptions,
): OIDCConfig<AzureDevOpsEntraProfile> {
  const trimmed = opts.tenant?.trim();
  const tenant = trimmed ? trimmed : "common";
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
  const baseScope = `openid profile email offline_access ${AZDO_RESOURCE_ID}/.default`;
  const scope = opts.extraScope ? `${baseScope} ${opts.extraScope}` : baseScope;
  return {
    id: "azure_devops",
    name: "Azure DevOps",
    type: "oidc",
    issuer,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
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
        id: profile.oid || profile.sub,
        name: profile.name ?? null,
        email: profile.email ?? profile.preferred_username ?? null,
        image: identifier ? avatarUrl("azure_devops", identifier) : null,
      };
    },
  };
}
