/**
 * Bootstrap seed. Mirrors values from environment variables (`.env.local` in
 * dev, the docker-compose env file in prod) into DB tables so the runtime
 * auth / LLM paths (DB-driven, no env fallback) have something to read on
 * the very first boot. Wired to `predev` for dev and to the docker entrypoint
 * for production self-host.
 *
 * Branches (each is independent and idempotent):
 *   - `DEV_OPENAI_API_KEY` → `LlmProvider` row (kind=openai). First row wins
 *     `isDefault: true`; subsequent runs leave the flag where it is so an
 *     admin tweak in the UI is not stomped.
 *   - `DEV_GITHUB_CLIENT_ID` + `DEV_GITHUB_CLIENT_SECRET` → an
 *     `OauthProviderConfig` row (kind=github).
 *
 * Gating: once the global `setup.complete` Setting is true (one LLM and one
 * OAuth provider have both been observed), the seed short-circuits. The DB
 * is the source of truth from then on; admin UI edits are never stomped,
 * even if the env vars still hold older values.
 *
 * Missing env or unavailable DB just logs a warning and exits 0 — never
 * blocks the server. Secrets land via `encryptSecret` so the on-disk row
 * matches whatever `SECRETS_KEY` policy is in effect.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";
import { PrismaClient } from "../src/db/generated/client";
import { encryptSecret, isEncryptionConfigured } from "../src/server/secrets/encryption";
import { decodeSettingValue } from "../src/server/settings/catalog";

loadEnv({ path: ".env.local" });

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn("[seed-dev] DATABASE_URL not set — skipping.");
    return;
  }

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const db = new PrismaClient({ adapter, log: ["error"] });

  try {
    const setupCompleteRow = await db.setting.findFirst({
      where: { key: "setup.complete", scope: "global", userId: null, projectId: null },
      select: { value: true },
      orderBy: { updatedAt: "desc" },
    });
    const setupComplete = decodeSettingValue("setup.complete", setupCompleteRow?.value ?? null);
    if (setupComplete) {
      console.log("[seed-dev] setup.complete is true — skipping (post-bootstrap).");
      return;
    }

    await seedOpenAi(db);
    await seedGithubOAuth(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[seed-dev] Skipped: ${message}`);
  } finally {
    await db.$disconnect();
  }
}

async function seedOpenAi(db: PrismaClient): Promise<void> {
  const apiKey = process.env.DEV_OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[seed-dev] DEV_OPENAI_API_KEY not set — skipping OpenAI seed.");
    return;
  }

  // Match by label so a user who has rotated their key in the admin UI
  // still gets bumped on a re-seed. We don't compare apiKey ciphertexts
  // (fresh IV would never byte-equal anyway).
  const label = "Local dev (OpenAI)";
  const existing = await db.llmProvider.findFirst({ where: { label } });
  const writeKey = encryptSecret(apiKey);

  if (!existing) {
    // First LLM row in the deployment? Seed it as the global default so the
    // agent has an adapter to dispatch to without any further admin work.
    const anyOther = await db.llmProvider.count();
    await db.llmProvider.create({
      data: {
        kind: "openai",
        label,
        apiKey: writeKey,
        model: "gpt-5",
        isDefault: anyOther === 0,
        enabled: true,
      },
    });
    console.log(
      `[seed-dev] Created LlmProvider(${label})${isEncryptionConfigured() ? " (encrypted)" : ""}.`,
    );
    return;
  }

  await db.llmProvider.update({
    where: { id: existing.id },
    data: { apiKey: writeKey, enabled: true },
  });
  console.log(`[seed-dev] Refreshed LlmProvider(${label}) apiKey.`);
}

async function seedGithubOAuth(db: PrismaClient): Promise<void> {
  const clientId = process.env.DEV_GITHUB_CLIENT_ID;
  const clientSecret = process.env.DEV_GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn(
      "[seed-dev] DEV_GITHUB_CLIENT_ID / DEV_GITHUB_CLIENT_SECRET not set — skipping GitHub OAuth seed.",
    );
    return;
  }

  const existing = await db.oauthProviderConfig.findFirst({ where: { kind: "github" } });
  const writeSecret = encryptSecret(clientSecret);

  if (!existing) {
    await db.oauthProviderConfig.create({
      data: {
        kind: "github",
        label: "GitHub (dev)",
        clientId,
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
  const idChanged = existing.clientId !== clientId;
  if (idChanged) {
    await db.oauthProviderConfig.update({
      where: { id: existing.id },
      data: {
        clientId,
        clientSecret: writeSecret,
        enabled: true,
      },
    });
    console.log("[seed-dev] Updated OauthProviderConfig(kind=github) credentials.");
  } else {
    console.log("[seed-dev] OauthProviderConfig(kind=github) already up to date.");
  }
}

main().catch((err) => {
  console.warn(`[seed-dev] Unexpected failure (non-fatal): ${err}`);
  process.exit(0);
});
