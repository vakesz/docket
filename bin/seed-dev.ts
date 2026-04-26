/**
 * Dev-only seed run by the `predev` script. Mirrors env-var GitHub OAuth
 * credentials into the OauthProviderConfig table so the runtime auth path
 * (DB-driven, no env fallback) can sign you in on `bun run dev`.
 *
 * Idempotent: upserts a single row per kind. Missing env or unavailable DB
 * just logs a warning and exits 0 — never blocks the dev server.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";
import { PrismaClient } from "../src/db/generated/client";
import { encryptSecret, isEncryptionConfigured } from "../src/server/secrets/encryption";

loadEnv({ path: ".env.local" });

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn("[seed-dev] DATABASE_URL not set — skipping.");
    return;
  }

  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!githubClientId || !githubClientSecret) {
    console.warn(
      "[seed-dev] GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not set — skipping GitHub OAuth seed.",
    );
    return;
  }

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const db = new PrismaClient({ adapter, log: ["error"] });

  try {
    const existing = await db.oauthProviderConfig.findFirst({
      where: { kind: "github" },
    });

    // Encrypt at-rest with SECRETS_KEY when set; otherwise the helper
    // returns plaintext (and warns once) so dev setups without a key still
    // boot. Compare against the *configured* env value, decrypting the row
    // only when needed, so a re-run that flips the key over a stable env
    // value is a no-op.
    const writeSecret = encryptSecret(githubClientSecret);

    if (!existing) {
      await db.oauthProviderConfig.create({
        data: {
          kind: "github",
          label: "GitHub (dev)",
          clientId: githubClientId,
          clientSecret: writeSecret,
          scopes: "read:user user:email repo",
          enabled: true,
        },
      });
      console.log(
        `[seed-dev] Created OauthProviderConfig(kind=github)${isEncryptionConfigured() ? " (encrypted)" : ""}.`,
      );
      return;
    }

    // Compare client id by-value; rewrap the secret unconditionally — we'd
    // need to decrypt to compare, and round-tripping a freshly-encrypted
    // ciphertext (different IV) wouldn't byte-equal the stored one anyway.
    const idChanged = existing.clientId !== githubClientId;
    if (idChanged) {
      await db.oauthProviderConfig.update({
        where: { id: existing.id },
        data: {
          clientId: githubClientId,
          clientSecret: writeSecret,
          enabled: true,
        },
      });
      console.log("[seed-dev] Updated OauthProviderConfig(kind=github) credentials.");
    } else {
      console.log("[seed-dev] OauthProviderConfig(kind=github) already up to date.");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[seed-dev] Skipped: ${message}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.warn(`[seed-dev] Unexpected failure (non-fatal): ${err}`);
  process.exit(0);
});
