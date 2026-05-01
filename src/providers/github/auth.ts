/**
 * NextAuth provider config for GitHub.
 *
 * Mirrors `src/providers/azure-devops/auth.ts` so the dispatch in
 * `src/server/providers/auth-build.ts` stays a pure switch — every concrete
 * `next-auth/providers/<x>` import lives next to the rest of its provider
 * package, and adding a new OAuth kind doesn't bloat the dispatcher.
 *
 * The `profile` callback intercepts the avatar URL, fetches the bytes via
 * the shared fetcher, writes them into the `Avatar` cache, and rewrites
 * `image` to the relative `/api/avatars/...` URL. That way the rest of the
 * app reads avatars from one source of truth and we drop the cross-origin
 * hot-link to `avatars.githubusercontent.com`.
 */

import "server-only";
import type { Provider } from "next-auth/providers";
import GitHub from "next-auth/providers/github";
import { avatarUrl } from "@/lib/avatar-url";
import { fetchAvatarFromProvider } from "@/server/avatars/fetchers";
import { persistAvatar } from "@/server/avatars/service";
import { db } from "@/server/db";
import { logger } from "@/server/logger";

export type GitHubAuthOptions = {
  clientId: string;
  clientSecret: string;
  /**
   * Override scopes. When omitted, GitHub's NextAuth provider derives them
   * from the default authorization URL.
   */
  scopes?: string | null;
};

type GitHubProfile = {
  id: number | string;
  name?: string | null;
  email?: string | null;
  login: string;
  avatar_url?: string | null;
};

export function githubAuthProvider(opts: GitHubAuthOptions): Provider {
  return GitHub({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    ...(opts.scopes ? { authorization: { params: { scope: opts.scopes } } } : {}),
    async profile(profile: GitHubProfile) {
      const login = profile.login;
      const image = login ? await captureAvatarBytes(login) : null;
      return {
        id: String(profile.id),
        name: profile.name ?? login ?? null,
        email: profile.email ?? null,
        image,
      };
    },
  });
}

async function captureAvatarBytes(identifier: string): Promise<string> {
  try {
    const fetched = await fetchAvatarFromProvider("github", identifier);
    await persistAvatar(db, {
      providerKind: "github",
      identifier,
      bytes: fetched?.bytes ?? null,
      contentType: fetched?.contentType ?? null,
      etag: fetched?.etag ?? null,
    });
  } catch (err) {
    logger.warn(
      {
        providerKind: "github",
        identifier,
        err: err instanceof Error ? err.message : String(err),
      },
      "auth: avatar capture failed; route will surface 404 until next sign-in",
    );
  }
  return avatarUrl("github", identifier);
}
