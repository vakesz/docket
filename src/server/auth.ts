import "server-only";
import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth, { type NextAuthConfig } from "next-auth";
import GitHub from "next-auth/providers/github";
import { db } from "@/server/db";
import { logger } from "@/server/logger";

/**
 * Dynamic NextAuth config — the `providers` array is built at request time
 * from `OauthProviderConfig` rows. Adding or removing a row in admin
 * settings makes the corresponding sign-in button appear/disappear on the
 * next page load; no restart needed.
 *
 * Phase 2 ships GitHub support only. Azure DevOps lands in Phase 9 with its
 * own custom provider (the OAuth flow is awkward enough to need its own
 * adapter, not stock NextAuth).
 *
 * Env vars are intentionally not consulted here. The dev seed
 * (`bin/seed-dev.ts`, wired to `predev`) writes a row from `.env.local`'s
 * `DEV_GITHUB_CLIENT_ID` / `DEV_GITHUB_CLIENT_SECRET` so the runtime path
 * stays identical between dev and prod.
 */
async function buildProviders(): Promise<NextAuthConfig["providers"]> {
  let rows: Awaited<ReturnType<typeof db.oauthProviderConfig.findMany>>;
  try {
    rows = await db.oauthProviderConfig.findMany({ where: { enabled: true } });
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
    switch (row.kind) {
      case "github":
        providers.push(
          GitHub({
            clientId: row.clientId,
            clientSecret: row.clientSecret,
            // GitHub's NextAuth provider derives scopes from the default
            // authorization URL; if the row carries an override, splice it in.
            ...(row.scopes ? { authorization: { params: { scope: row.scopes } } } : {}),
          }),
        );
        break;
      // case "azure_devops": Phase 9 — custom provider lives in src/providers/azure-devops/
      default:
        logger.warn({ kind: row.kind }, "auth: unknown OauthProviderConfig kind, skipping");
    }
  }
  return providers;
}

export const { handlers, signIn, signOut, auth } = NextAuth(async () => {
  const providers = await buildProviders();
  return {
    adapter: PrismaAdapter(db),
    session: { strategy: "database" },
    providers,
  } satisfies NextAuthConfig;
});
