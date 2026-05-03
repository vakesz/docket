/**
 * Bootstrap seed. Mirrors values from environment variables (`.env.local` in
 * dev, the docker-compose env file in prod) into DB tables so the runtime
 * auth / LLM paths (DB-driven, no env fallback) have something to read on
 * the very first boot. Wired to `predev` for dev and to the docker entrypoint
 * for production self-host.
 *
 * Branches (each is independent and idempotent):
 *   - `DEV_OPENAI_API_KEY` → `LlmProvider` row (kind=openai, role=chat).
 *     First chat row wins `isDefault: true` for the chat role; subsequent
 *     runs leave the flag where it is so an admin tweak in the UI is not
 *     stomped. Guardrail rows are admin-managed only.
 *   - `DEV_GITHUB_CLIENT_ID` + `DEV_GITHUB_CLIENT_SECRET` → an
 *     `OauthProviderConfig` row (kind=github).
 *   - `DEV_AZURE_DEVOPS_CLIENT_ID` + `DEV_AZURE_DEVOPS_CLIENT_SECRET`
 *     (+ optional `DEV_AZURE_DEVOPS_TENANT_ID`) → an `OauthProviderConfig`
 *     row (kind=azure_devops). The tenant id rides in `metadata.tenant` to
 *     match `auth-build.ts`; empty falls back to the multi-tenant `common`
 *     endpoint.
 *
 * Idempotency comes from each branch's own existence check. There is no
 * gate on `setup.complete` — that bit is owned by the in-browser wizard.
 *
 * Missing env or unavailable DB just logs a warning and exits 0 — never
 * blocks the server. Secrets land via `encryptSecret` so the on-disk row
 * matches whatever `SECRETS_KEY` policy is in effect.
 */

import { config as loadEnv } from "dotenv";
import { count, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { llmProviders, oauthProviderConfigs } from "../src/db/schema";
import { encryptSecret } from "../src/server/secrets/encryption";

type SeedDb = PostgresJsDatabase<typeof schema>;

// Match drizzle.config.ts precedence: .env.local first, then .env fills any gaps.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.warn("[seed-dev] DATABASE_URL not set — skipping.");
    return;
  }

  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  const db = drizzle(sql, { schema, casing: "snake_case" });

  try {
    await seedOpenAi(db);
    await seedGithubOAuth(db);
    await seedAzureDevOpsOAuth(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[seed-dev] Skipped: ${message}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function seedOpenAi(db: SeedDb): Promise<void> {
  const apiKey = process.env["DEV_OPENAI_API_KEY"];
  if (!apiKey) {
    console.warn("[seed-dev] DEV_OPENAI_API_KEY not set — skipping OpenAI seed.");
    return;
  }

  // Match by (kind, role='chat') so a user who renamed the row in the admin
  // UI still gets their apiKey bumped on a re-seed without having the label
  // clobbered back. Ciphertexts can't be byte-compared (fresh IV).
  const existing = await db.query.llmProviders.findFirst({
    where: (t, { and, eq }) => and(eq(t.kind, "openai"), eq(t.role, "chat")),
  });
  const writeKey = encryptSecret(apiKey);

  if (!existing) {
    // First chat row in the deployment? Seed it as the global chat default
    // so the agent has an adapter to dispatch to without any further admin
    // work. Guardrail-role rows have an independent default.
    const chatRows = await db
      .select({ c: count() })
      .from(llmProviders)
      .where(eq(llmProviders.role, "chat"));
    const chatCount = chatRows[0]?.c ?? 0;
    const label = "OpenAI";
    await db.insert(llmProviders).values({
      kind: "openai",
      role: "chat",
      label,
      apiKey: writeKey,
      model: process.env["DEV_OPENAI_MODEL"]?.trim() || "gpt-5",
      baseUrl: process.env["DEV_OPENAI_BASE_URL"]?.trim() || "",
      inputPriceCentsPerMtok: parsePrice(process.env["DEV_OPENAI_INPUT_PRICE_CENTS_PER_MTOK"]),
      outputPriceCentsPerMtok: parsePrice(process.env["DEV_OPENAI_OUTPUT_PRICE_CENTS_PER_MTOK"]),
      isDefault: chatCount === 0,
      enabled: true,
    });
    console.log(`[seed-dev] Created LlmProvider(${label}) (encrypted).`);
    return;
  }

  // Fill in fields that are still at their schema defaults (empty / null) from
  // env without stomping admin edits — once a value is in the row, it wins.
  const envModel = process.env["DEV_OPENAI_MODEL"]?.trim();
  const envBaseUrl = process.env["DEV_OPENAI_BASE_URL"]?.trim();
  const envInputPrice = parsePrice(process.env["DEV_OPENAI_INPUT_PRICE_CENTS_PER_MTOK"]);
  const envOutputPrice = parsePrice(process.env["DEV_OPENAI_OUTPUT_PRICE_CENTS_PER_MTOK"]);

  const data: Partial<typeof llmProviders.$inferInsert> = { apiKey: writeKey, enabled: true };
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

  await db.update(llmProviders).set(data).where(eq(llmProviders.id, existing.id));
  const extras = filled.length ? ` + filled blanks: ${filled.join(", ")}` : "";
  console.log(`[seed-dev] Refreshed LlmProvider(${existing.label}) apiKey${extras}.`);
}

function parsePrice(raw: string | undefined): string | null {
  if (!raw) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n.toString() : null;
}

async function seedGithubOAuth(db: SeedDb): Promise<void> {
  const clientId = process.env["DEV_GITHUB_CLIENT_ID"];
  const clientSecret = process.env["DEV_GITHUB_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    console.warn(
      "[seed-dev] DEV_GITHUB_CLIENT_ID / DEV_GITHUB_CLIENT_SECRET not set — skipping GitHub OAuth seed.",
    );
    return;
  }

  const existing = await db.query.oauthProviderConfigs.findFirst({
    where: (t, { eq }) => eq(t.kind, "github"),
  });
  const writeSecret = encryptSecret(clientSecret);

  if (!existing) {
    await db.insert(oauthProviderConfigs).values({
      kind: "github",
      label: "GitHub",
      clientId,
      clientSecret: writeSecret,
      scopes: "read:user user:email repo",
      enabled: true,
    });
    console.log("[seed-dev] Created OauthProviderConfig(kind=github) (encrypted).");
    return;
  }

  // Compare client id by-value; rewrap the secret unconditionally — we'd
  // need to decrypt to compare, and round-tripping a freshly-encrypted
  // ciphertext (different IV) wouldn't byte-equal the stored one anyway.
  if (existing.clientId !== clientId) {
    await db
      .update(oauthProviderConfigs)
      .set({ clientId, clientSecret: writeSecret, enabled: true })
      .where(eq(oauthProviderConfigs.id, existing.id));
    console.log("[seed-dev] Updated OauthProviderConfig(kind=github) credentials.");
  } else {
    console.log("[seed-dev] OauthProviderConfig(kind=github) already up to date.");
  }
}

async function seedAzureDevOpsOAuth(db: SeedDb): Promise<void> {
  const clientId = process.env["DEV_AZURE_DEVOPS_CLIENT_ID"];
  const clientSecret = process.env["DEV_AZURE_DEVOPS_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    console.warn(
      "[seed-dev] DEV_AZURE_DEVOPS_CLIENT_ID / DEV_AZURE_DEVOPS_CLIENT_SECRET not set — skipping Azure DevOps OAuth seed.",
    );
    return;
  }

  const tenant = process.env["DEV_AZURE_DEVOPS_TENANT_ID"]?.trim() ?? "";
  const existing = await db.query.oauthProviderConfigs.findFirst({
    where: (t, { eq }) => eq(t.kind, "azure_devops"),
  });
  const writeSecret = encryptSecret(clientSecret);

  if (!existing) {
    await db.insert(oauthProviderConfigs).values({
      kind: "azure_devops",
      label: "Azure DevOps",
      clientId,
      clientSecret: writeSecret,
      scopes: "",
      metadata: tenant ? { tenant } : {},
      enabled: true,
    });
    console.log("[seed-dev] Created OauthProviderConfig(kind=azure_devops) (encrypted).");
    return;
  }

  // Same approach as GitHub: compare by clientId, rewrap the secret each
  // time (fresh IV → ciphertexts can't be byte-compared). Tenant change
  // also forces a refresh so `.env` edits propagate without a manual UI poke.
  const idChanged = existing.clientId !== clientId;
  const meta = existing.metadata ?? {};
  const currentTenant = typeof meta.tenant === "string" ? meta.tenant : "";
  const tenantChanged = currentTenant !== tenant;
  if (idChanged || tenantChanged) {
    const { tenant: _drop, ...rest } = meta;
    const nextMeta = tenant ? { ...rest, tenant } : rest;
    await db
      .update(oauthProviderConfigs)
      .set({
        clientId,
        clientSecret: writeSecret,
        metadata: nextMeta,
        enabled: true,
      })
      .where(eq(oauthProviderConfigs.id, existing.id));
    console.log("[seed-dev] Updated OauthProviderConfig(kind=azure_devops) credentials.");
  } else {
    console.log("[seed-dev] OauthProviderConfig(kind=azure_devops) already up to date.");
  }
}

main().catch((err) => {
  console.warn(`[seed-dev] Unexpected failure (non-fatal): ${err}`);
  process.exit(0);
});
