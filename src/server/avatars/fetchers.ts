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
 * cheaply (cross-user lookup needs an Identities-API resolution we haven't
 * wired). Keeping this layer adapter-shaped lets us extend providers
 * without growing the work-item interface.
 */

import "server-only";
import { logger } from "@/server/logger";

const FETCH_TIMEOUT_MS = 5000;

/**
 * GitHub serves every public profile photo at this URL — it 302s to the
 * actual avatar CDN, which means a single GET gives us the bytes for any
 * login without an authenticated API call. `size=128` is the smallest size
 * that still looks crisp on retina displays for the chip + account button
 * (rendered at 16-32 CSS px).
 */
function githubAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=128`;
}

/**
 * AzDO Profile API — only `me` works without a per-user identity descriptor
 * resolution. Returns the avatar inline as base64 in `value`.
 */
const AZDO_ME_AVATAR_URL =
  "https://app.vssps.visualstudio.com/_apis/profile/profiles/me/avatar?size=medium&api-version=7.1-preview.1";

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
  switch (providerKind) {
    case "github":
      return fetchGitHubAvatar(identifier);
    case "azure_devops":
      if (!opts.isSelf || !opts.accessToken) return null;
      return fetchAzureDevOpsMeAvatar(opts.accessToken);
    default:
      return null;
  }
}

async function fetchGitHubAvatar(login: string): Promise<FetchedAvatar | null> {
  const res = await fetch(githubAvatarUrl(login), {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`github avatar fetch failed: ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0) return null;
  const contentType = res.headers.get("content-type") ?? "image/png";
  const etag = res.headers.get("etag");
  return { bytes: buf, contentType, etag };
}

async function fetchAzureDevOpsMeAvatar(accessToken: string): Promise<FetchedAvatar | null> {
  const res = await fetch(AZDO_ME_AVATAR_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
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
}

/**
 * Sniff the leading bytes of the decoded payload — AzDO's avatar endpoint
 * doesn't surface a content-type alongside the base64 blob, so we infer
 * from the file's magic header. PNG/JPEG/GIF/WebP cover everything AzDO
 * accepts as a profile photo today.
 */
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
