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
import type { ProviderAuthInput } from "@/core/provider";
import type { UserId } from "@/core/types";
import { db } from "@/db";
import { avatarUrl } from "@/lib/avatar-url";
import { fetchAvatarFromProvider } from "@/server/avatars/fetchers";
import { persistAvatar } from "@/server/avatars/service";
import { logger } from "@/server/logger";

type GitHubProfile = {
  id: number | string;
  name?: string | null;
  email?: string | null;
  login: string;
  avatar_url?: string | null;
};

/**
 * Spec-side `buildAuthProvider` for GitHub. Receives the dispatcher's
 * normalized `ProviderAuthInput`; baseUrl / metadata are unused on
 * github.com but flow through unchanged for GitHub Enterprise wiring later.
 */
export function buildGithubAuthProvider(input: ProviderAuthInput): Provider {
  return GitHub({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    ...(input.scopes ? { authorization: { params: { scope: input.scopes } } } : {}),
    async profile(profile: GitHubProfile) {
      const login = profile.login;
      const image = login ? await captureAvatarBytes(login) : null;
      return {
        id: String(profile.id) as UserId,
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
