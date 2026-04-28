/**
 * Public GitHub avatar fetcher.
 *
 * GitHub serves every public profile photo at `https://github.com/<login>.png`,
 * which 302s to the actual avatar CDN. A single GET gives us the bytes for
 * any login without an authenticated API call. `size=128` is the smallest
 * size that still looks crisp on retina displays for the chip + account
 * button (rendered at 16-32 CSS px).
 *
 * Wired into the GitHub spec's `avatarFetcher` slot; the server-side
 * dispatcher in `src/server/avatars/fetchers.ts` reaches for it via
 * `getProviderSpec("github")` rather than knowing about GitHub directly.
 */

import "server-only";
import type { ProviderAvatarFetcher } from "@/core/provider";

const FETCH_TIMEOUT_MS = 5000;

function githubAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=128`;
}

export const githubAvatarFetcher: ProviderAvatarFetcher = async (login) => {
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
};
