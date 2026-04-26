import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { db } from "@/server/db";

/**
 * Phase 0 wiring: GitHub OAuth from env. Phase 2 swaps the adapter to a
 * dynamic provider config sourced from the `OauthProviderConfig` table so
 * operators can add OAuth providers from the admin UI without a redeploy.
 */
export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: "database" },
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    }),
  ],
});
