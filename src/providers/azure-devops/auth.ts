/**
 * Custom NextAuth provider for Azure DevOps.
 *
 * AzDO's OAuth story is awkward: Microsoft has *deprecated* the legacy
 * `app.vssps.visualstudio.com/oauth2/*` flow (the one NextAuth ships
 * out-of-the-box as `azure-devops`) and now recommends Microsoft Entra ID
 * with the AzDO resource scope. We follow that recommendation — the user
 * registers an Entra app, grants it `499b84ac-1321-427f-aa17-267ca6975798`
 * (the well-known AzDO API resource id), and we ask for the `.default`
 * scope on top of OIDC.
 *
 * Provider id is set to `azure_devops` (matching `OauthProviderConfig.kind`
 * and `Project.providerKind`) so the NextAuth `Account.provider` column
 * lines up with what `buildProviderForUser` looks up. That symmetry is
 * load-bearing — change one side, change both.
 *
 * Tenant: callers pass either a specific tenant guid or the literal
 * `common` (the default). For org-internal apps a single-tenant guid is
 * the right choice; for ones that need to support multiple AAD tenants,
 * `common` works.
 */

import "server-only";
import type { OIDCConfig } from "next-auth/providers";
import { logger } from "@/server/logger";

const AZDO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

const AZDO_AVATAR_URL =
  "https://app.vssps.visualstudio.com/_apis/profile/profiles/me/avatar?size=medium&api-version=7.1-preview.1";

const AVATAR_FETCH_TIMEOUT_MS = 5000;

/**
 * Fetch the signed-in user's avatar from the AzDO Profile API and return it
 * as a `data:` URL the browser can render directly.
 *
 * We can't reach Microsoft Graph (`/me/photo/$value`) here because Entra
 * tokens are per-resource — our access token carries the AzDO `.default`
 * scope, not Graph. Asking for both would force a multi-resource consent
 * dance. The AzDO Profile API uses the same scope we already have, returns
 * the avatar inline as base64, and matches GitHub's "image is captured at
 * sign-in" behavior.
 *
 * Returns null on any failure (no token, network error, 404 because the
 * user never set a custom avatar) — the topbar falls back to an initial
 * just like for any provider that doesn't surface an image.
 */
async function fetchAzureDevOpsAvatar(accessToken: string | undefined): Promise<string | null> {
  if (!accessToken) return null;
  try {
    const res = await fetch(AZDO_AVATAR_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 404 = user has no custom avatar (AzDO renders initials there too).
      // 401/403 = token doesn't carry profile read perms; surface as null.
      if (res.status !== 404) {
        logger.warn(
          { status: res.status },
          "azure-devops: avatar fetch returned non-OK; falling back to initial",
        );
      }
      return null;
    }
    const json = (await res.json()) as { value?: string };
    const b64 = json.value?.trim();
    if (!b64) return null;
    return `data:${detectImageMime(b64)};base64,${b64}`;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "azure-devops: avatar fetch threw; falling back to initial",
    );
    return null;
  }
}

/**
 * The AzDO avatar endpoint doesn't return a content-type alongside the
 * base64 payload — it's whatever the user uploaded. Sniff the leading
 * base64 bytes (which decode 1:1 to the file's magic header) so the data
 * URL renders correctly in browsers that strict-check MIME.
 */
function detectImageMime(b64: string): string {
  if (b64.startsWith("iVBORw0K")) return "image/png";
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/png";
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
    async profile(profile, tokens) {
      return {
        id: profile.oid || profile.sub,
        name: profile.name ?? null,
        email: profile.email ?? profile.preferred_username ?? null,
        image: await fetchAzureDevOpsAvatar(tokens?.access_token),
      };
    },
  };
}
