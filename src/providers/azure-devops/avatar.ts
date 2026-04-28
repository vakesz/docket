/**
 * Azure DevOps avatar fetcher.
 *
 * Only `me` works without a per-user identity-descriptor resolution — AzDO's
 * Profile API requires the descriptor for cross-user lookups, which needs
 * an Identities-API hop we haven't wired. Cross-user calls return null and
 * the UI falls back to initials. The signed-in user's avatar gets captured
 * during the OAuth callback in `src/providers/azure-devops/auth.ts` using
 * the same fetcher (`isSelf: true`).
 *
 * The Profile API returns the avatar inline as base64 in `value`; AzDO
 * doesn't surface a content-type alongside the blob, so we sniff it from
 * the file's magic header.
 */

import "server-only";
import type { ProviderAvatarFetcher } from "@/core/provider";
import { logger } from "@/server/logger";

const FETCH_TIMEOUT_MS = 5000;

const AZDO_ME_AVATAR_URL =
  "https://app.vssps.visualstudio.com/_apis/profile/profiles/me/avatar?size=medium&api-version=7.1-preview.1";

export const azureDevOpsAvatarFetcher: ProviderAvatarFetcher = async (_identifier, opts) => {
  if (!opts.isSelf || !opts.accessToken) return null;
  const res = await fetch(AZDO_ME_AVATAR_URL, {
    headers: { Authorization: `Bearer ${opts.accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      logger.warn(
        { status: res.status },
        "avatars: AzDO me-avatar fetch denied; treating as missing",
      );
      return null;
    }
    throw new Error(`azure_devops avatar fetch failed: ${res.status}`);
  }
  const json = (await res.json()) as { value?: string };
  const b64 = json.value?.trim();
  if (!b64) return null;
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  if (bytes.byteLength === 0) return null;
  return { bytes, contentType: detectImageMime(bytes) };
};

function detectImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45
  ) {
    return "image/webp";
  }
  return "image/png";
}
