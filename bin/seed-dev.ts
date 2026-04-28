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
 * Idempotency comes from each branch's own existence check. There is no
 * gate on `setup.complete` — that bit is owned by the in-browser wizard
 * (`src/server/setup/router.ts`) and the `getSetupStatus` reader. Setting
 * `DEV_*` envs *after* the wizard has already flipped the bit will still
 * fill in any missing rows (e.g. a user who finished the wizard with
 * just an OAuth provider, then later set `DEV_OPENAI_API_KEY`).
 *
 * Missing env or unavailable DB just logs a warning and exits 0 — never
 * blocks the server. Secrets land via `encryptSecret` so the on-disk row
 * matches whatever `SECRETS_KEY` policy is in effect.
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

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const db = new PrismaClient({ adapter, log: ["error"] });

  try {
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

  // Match by kind, not label, so a user who renamed the row in the admin UI
  // still gets their apiKey bumped on a re-seed without having the label
  // clobbered back. Ciphertexts can't be byte-compared (fresh IV).
  const existing = await db.llmProvider.findFirst({ where: { kind: "openai" } });
  const writeKey = encryptSecret(apiKey);

  if (!existing) {
    // First LLM row in the deployment? Seed it as the global default so the
    // agent has an adapter to dispatch to without any further admin work.
    const anyOther = await db.llmProvider.count();
    const label = "OpenAI";
    await db.llmProvider.create({
      data: {
        kind: "openai",
        label,
        apiKey: writeKey,
        model: process.env.DEV_OPENAI_MODEL?.trim() || "gpt-5",
        baseUrl: process.env.DEV_OPENAI_BASE_URL?.trim() || "",
        inputPriceCentsPerMtok: parsePrice(process.env.DEV_OPENAI_INPUT_PRICE_CENTS_PER_MTOK),
        outputPriceCentsPerMtok: parsePrice(process.env.DEV_OPENAI_OUTPUT_PRICE_CENTS_PER_MTOK),
        isDefault: anyOther === 0,
        enabled: true,
      },
    });
    console.log(
      `[seed-dev] Created LlmProvider(${label})${isEncryptionConfigured() ? " (encrypted)" : ""}.`,
    );
    return;
  }

  // Fill in fields that are still at their schema defaults (empty / null) from
  // env without stomping admin edits — once a value is in the row, it wins.
  const envModel = process.env.DEV_OPENAI_MODEL?.trim();
  const envBaseUrl = process.env.DEV_OPENAI_BASE_URL?.trim();
  const envInputPrice = parsePrice(process.env.DEV_OPENAI_INPUT_PRICE_CENTS_PER_MTOK);
  const envOutputPrice = parsePrice(process.env.DEV_OPENAI_OUTPUT_PRICE_CENTS_PER_MTOK);

  const data: Record<string, unknown> = { apiKey: writeKey, enabled: true };
  const filled: string[] = [];
  if (envModel && existing.model === "") {
    data.model = envModel;
    filled.push("model");
  }
  if (envBaseUrl && existing.baseUrl === "") {
    data.baseUrl = envBaseUrl;
    filled.push("baseUrl");
  }
  if (envInputPrice !== null && existing.inputPriceCentsPerMtok === null) {
    data.inputPriceCentsPerMtok = envInputPrice;
    filled.push("inputPriceCentsPerMtok");
  }
  if (envOutputPrice !== null && existing.outputPriceCentsPerMtok === null) {
    data.outputPriceCentsPerMtok = envOutputPrice;
    filled.push("outputPriceCentsPerMtok");
  }

  await db.llmProvider.update({ where: { id: existing.id }, data });
  const extras = filled.length ? ` + filled blanks: ${filled.join(", ")}` : "";
  console.log(`[seed-dev] Refreshed LlmProvider(${existing.label}) apiKey${extras}.`);
}

function parsePrice(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
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
