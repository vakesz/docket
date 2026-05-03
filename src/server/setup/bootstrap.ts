import "server-only";
import { TRPCError } from "@trpc/server";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { LLM_KINDS } from "@/agent/llm/types";
import type { Db } from "@/db";
import type { OauthProviderConfigMetadata } from "@/db/schema";
import { llmProviders, oauthProviderConfigs } from "@/db/schema";
import { LLM_ROLES } from "@/server/llm/lookup";
import { PriceCentsPerMtokSchema, priceToString } from "@/server/llm/pricing";
import { logger } from "@/server/logger";
import { getProviderSpec, listProviderSpecs } from "@/server/provider-registry";
import { encryptSecret } from "@/server/secrets/encryption";
import { getSetupStatus, type SetupStatus } from "@/server/setup/status";

/**
 * Per-LLM-kind defaults for label and model when the wizard input leaves
 * them blank. Kept here (vs imported from the settings router) so the
 * wizard stays decoupled from `mutationProcedure` and the trpc/auth import
 * chain — the test suite can't pull `next-auth` in.
 *
 * The shape is keyed by `(kind, role)` so adding a new vendor only needs
 * one new entry. Roles default independently — a deployment can run
 * Anthropic for chat and OpenAI for guardrail (or vice versa).
 */
type LlmRoleDefaults = { label: string; model: string };
type LlmKindDefaults = Record<"chat" | "guardrail", LlmRoleDefaults>;

const LLM_DEFAULTS_BY_KIND: Record<(typeof LLM_KINDS)[number], LlmKindDefaults> = {
  openai: {
    chat: { label: "OpenAI", model: "gpt-5" },
    guardrail: { label: "OpenAI guardrail", model: "gpt-5-nano" },
  },
  anthropic: {
    chat: { label: "Anthropic Claude", model: "claude-sonnet-4-6" },
    guardrail: { label: "Claude guardrail", model: "claude-haiku-4-5-20251001" },
  },
};

const LlmRole = z.enum(LLM_ROLES);
const LlmKind = z.enum(LLM_KINDS);

/**
 * Per-provider OAuth input the wizard collects. `typeId` picks which spec
 * the row applies to; `aux` carries the provider-specific extra (Entra
 * tenant id, etc.) and bootstrap routes it via the spec's `oauth.auxSlot`
 * to `metadata.tenant`.
 *
 * Cross-field validation (per-provider scope defaults, aux-required) runs
 * inside `applyBootstrap` against the registry so the schema stays
 * provider-agnostic.
 */
const OauthInput = z.object({
  typeId: z.string().min(1).max(80),
  label: z.string().min(1).max(80),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(500),
  scopes: z.string().max(500).default(""),
  aux: z.string().max(500).default(""),
});

/**
 * One LLM row staged by the wizard. `kind` picks which adapter the row
 * feeds (`LLM_KINDS` lists the wired ones); `role` decides whether the row
 * feeds the agent loop (`chat`) or the guardrail classifier (`guardrail`).
 * Bootstrap may receive multiple entries — typically one per role — and
 * creates them in order, skipping any (kind, role) pair that already has
 * a row in the deployment.
 */
const LlmInput = z.object({
  kind: LlmKind.default(LLM_KINDS[0]),
  role: LlmRole.default("chat"),
  label: z.string().min(1).max(80).default(""),
  apiKey: z.string().min(1).max(500),
  /** Free-text model name — falls back to a (kind, role) default if blank. */
  model: z.string().max(120).default(""),
  /** Optional vendor-specific base URL override (Azure OpenAI proxy, etc.). */
  baseUrl: z.string().max(500).default(""),
  /** USD per million tokens × 100, matches LlmProvider columns. Null = unknown / unlogged. */
  inputPriceCentsPerMtok: PriceCentsPerMtokSchema.default(null),
  outputPriceCentsPerMtok: PriceCentsPerMtokSchema.default(null),
});

export const BootstrapInput = z
  .object({
    /**
     * Zero or more OAuth provider rows to seed. Each row carries its
     * `typeId` so the wizard can iterate over `PROVIDER_SPECS` without a
     * `if (kind === ...)` chain. Cap at 8 to keep bootstrap from
     * accidentally batching huge writes — beyond that, the operator should
     * use the regular settings panel.
     */
    oauthProviders: z.array(OauthInput).max(8).default([]),
    /**
     * Zero or more LLM rows to seed. The wizard typically submits one
     * `chat` row and optionally one `guardrail` row, but the shape allows
     * for future expansion (multiple chat models in one go, etc.). Cap at
     * 8 to keep bootstrap from accidentally batching huge writes — beyond
     * that, the operator should use the regular settings panel.
     */
    llms: z.array(LlmInput).max(8).default([]),
  })
  .refine((value) => value.oauthProviders.length > 0, {
    message: "At least one OAuth provider is required to finish setup.",
  })
  .refine(
    (value) => {
      const seen = new Set<string>();
      for (const oauth of value.oauthProviders) {
        if (seen.has(oauth.typeId)) return false;
        seen.add(oauth.typeId);
      }
      return true;
    },
    { message: "Each OAuth provider can be configured at most once in the wizard." },
  )
  .refine(
    (value) => {
      const seen = new Set<string>();
      for (const llm of value.llms) {
        const key = `${llm.kind}:${llm.role}`;
        if (seen.has(key)) return false;
        seen.add(key);
      }
      return true;
    },
    { message: "Each (kind, role) pair can be configured at most once in the wizard." },
  );

export type BootstrapInputType = z.infer<typeof BootstrapInput>;

/**
 * One-shot bootstrap. Creates rows for whatever sections the user filled
 * in, leaves rows that already exist alone, and lets `getSetupStatus`
 * flip the sticky bit at the end. Idempotent against "operator filled in
 * one provider, came back to add another" — but rejects outright once
 * `setup.complete` is true to stop a stale tab from silently
 * re-bootstrapping a running deployment.
 */
export async function applyBootstrap(db: Db, input: BootstrapInputType): Promise<SetupStatus> {
  const before = await getSetupStatus(db);
  if (before.complete) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Setup is already complete. Use the settings page to add more providers.",
    });
  }

  logger.info(
    {
      oauthCount: input.oauthProviders.length,
      llmCount: input.llms.length,
    },
    "setup: bootstrap start",
  );

  for (const oauth of input.oauthProviders) {
    const spec = getProviderSpec(oauth.typeId);
    if (!spec?.oauth) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Unknown OAuth provider '${oauth.typeId}'.`,
      });
    }
    const aux = oauth.aux.trim();
    if (spec.oauth.auxRequired && !aux) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${spec.displayName}: '${spec.oauth.auxLabel}' is required.`,
      });
    }
    const existing = await db.query.oauthProviderConfigs.findFirst({
      where: eq(oauthProviderConfigs.kind, oauth.typeId),
    });
    if (existing) {
      logger.info({ kind: oauth.typeId }, "setup: oauth provider already exists; skipping");
      continue;
    }
    await db.insert(oauthProviderConfigs).values({
      kind: oauth.typeId,
      label: oauth.label.trim() || spec.oauth.defaultLabel,
      clientId: oauth.clientId.trim(),
      clientSecret: encryptSecret(oauth.clientSecret),
      scopes: oauth.scopes.trim() || spec.oauth.defaultScopes,
      metadata: persistAux(spec.oauth.auxSlot, aux),
      enabled: true,
    });
    logger.info({ kind: oauth.typeId }, "setup: oauth provider created");
  }

  // Defense-in-depth: even if the registry is empty, surface the misconfig.
  const oauthCapableSpecs = listProviderSpecs().filter((spec) => spec.oauth !== null);
  if (oauthCapableSpecs.length === 0) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "No OAuth-capable providers are registered. Check the provider registry.",
    });
  }

  for (const llm of input.llms) {
    const defaults =
      LLM_DEFAULTS_BY_KIND[llm.kind][llm.role] ??
      ({ label: llm.kind, model: "" } satisfies LlmRoleDefaults);
    // Skip if a row already exists for this (kind, role) — the wizard is
    // idempotent against returning operators who configured one role
    // earlier and are now adding the other.
    const existing = await db.query.llmProviders.findFirst({
      where: and(eq(llmProviders.kind, llm.kind), eq(llmProviders.role, llm.role)),
    });
    if (existing) {
      logger.info(
        { kind: llm.kind, role: llm.role },
        "setup: llm provider already exists; skipping",
      );
      continue;
    }
    // First row of this role in the deployment becomes its `isDefault`,
    // so the chat / guardrail resolvers have something to dispatch to
    // without further admin work. Roles default independently.
    const anyForRoleRows = await db
      .select({ c: count() })
      .from(llmProviders)
      .where(eq(llmProviders.role, llm.role));
    const anyForRole = anyForRoleRows[0]?.c ?? 0;
    await db.insert(llmProviders).values({
      kind: llm.kind,
      role: llm.role,
      label: llm.label.trim() || defaults.label,
      apiKey: encryptSecret(llm.apiKey),
      model: llm.model.trim() || defaults.model,
      baseUrl: llm.baseUrl.trim(),
      inputPriceCentsPerMtok: priceToString(llm.inputPriceCentsPerMtok),
      outputPriceCentsPerMtok: priceToString(llm.outputPriceCentsPerMtok),
      isDefault: anyForRole === 0,
      enabled: true,
    });
    logger.info(
      { kind: llm.kind, role: llm.role, isDefault: anyForRole === 0 },
      "setup: llm provider created",
    );
  }

  // Re-read so the sticky bit flips in the same DB session and the
  // caller can `router.refresh()` straight into a redirect.
  const after = await getSetupStatus(db);
  logger.info({ complete: after.complete }, "setup: bootstrap complete");
  return after;
}

/**
 * Route the OAuth form's auxiliary input to the storage slot the spec
 * declares. Mirrors `writeAux` in `src/server/oauth/router.ts` so wizard
 * and admin-edit paths persist the same shape. Currently only the
 * `metadataTenant` slot is used — the legacy `baseUrl` slot was retired
 * along with the column.
 */
function persistAux(
  auxSlot: "baseUrl" | "metadataTenant",
  value: string,
): OauthProviderConfigMetadata {
  const trimmed = value.trim();
  if (auxSlot === "metadataTenant" && trimmed) {
    return { tenant: trimmed };
  }
  return {};
}
