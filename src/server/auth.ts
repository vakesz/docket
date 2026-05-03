import "server-only";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import NextAuth, { type NextAuthConfig } from "next-auth";
import { cache } from "react";
import { db } from "@/db";
import { accounts, oauthProviderConfigs, sessions, users, verificationTokens } from "@/db/schema";
import { logger } from "@/server/logger";
import { buildAuthProvider, UnknownOauthKindError } from "@/server/providers/auth-build";

/**
 * Dynamic NextAuth config — the `providers` array is built at request time
 * from `OauthProviderConfig` rows. Adding or removing a row in admin
 * settings makes the corresponding sign-in button appear/disappear on the
 * next page load; no restart needed.
 *
 * Azure DevOps signs in via Microsoft Entra ID — the legacy app.vssps
 * OAuth flow is deprecated, so the AzDO row uses an Entra app registration
 * with the AzDO resource scope (its tenant goes in the
 * `OauthProviderConfig.scopes` column for now, since the schema already has
 * a free-form string field for provider-specific config).
 *
 * Env vars are intentionally not consulted here. The provider bootstrap
 * (`bin/bootstrap-providers.ts`, wired to `predev`) writes a row from
 * `.env.local`'s `DEV_GITHUB_CLIENT_ID` / `DEV_GITHUB_CLIENT_SECRET` so the
 * runtime path stays identical between dev and prod.
 */
async function buildProviders(): Promise<NextAuthConfig["providers"]> {
  let rows: Awaited<ReturnType<typeof db.query.oauthProviderConfigs.findMany>>;
  try {
    rows = await db.query.oauthProviderConfigs.findMany({
      where: eq(oauthProviderConfigs.enabled, true),
    });
  } catch (err) {
    // Database isn't reachable or the table doesn't exist yet (pre-migration).
    // Log once and return no providers; sign-in pages render with no buttons,
    // which is the right signal that setup hasn't completed.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "auth: failed to load OauthProviderConfig rows; rendering with no sign-in buttons",
    );
    return [];
  }

  const providers: NextAuthConfig["providers"] = [];
  for (const row of rows) {
    try {
      providers.push(buildAuthProvider(row));
    } catch (err) {
      if (err instanceof UnknownOauthKindError) {
        // A row exists for a provider kind that isn't wired into auth-build.
        // Skip the row so the rest of the sign-in page still renders, but log
        // loudly so the gap surfaces in dev/CI rather than disappearing into a
        // silent return null.
        logger.warn({ kind: err.kind }, "auth: unknown OauthProviderConfig kind, skipping");
        continue;
      }
      throw err;
    }
  }
  return providers;
}

const nextAuth = NextAuth(async () => {
  const providers = await buildProviders();
  return {
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }),
    session: { strategy: "database" },
    providers,
  } satisfies NextAuthConfig;
});

export const { handlers, signIn, signOut } = nextAuth;

// `cache()` dedupes the auth call within a single RSC render, collapsing
// the 2-3 calls per page (root layout + nested layouts + page) into one
// session lookup. Outside React (route handlers, tRPC ctx), it's a no-op.
export const auth: typeof nextAuth.auth = cache(nextAuth.auth) as typeof nextAuth.auth;
