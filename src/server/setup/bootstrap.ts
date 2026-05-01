import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { db as Db } from "@/server/db";
import { logger } from "@/server/logger";
import { encryptSecret } from "@/server/secrets/encryption";
import { getSetupStatus, type SetupStatus } from "@/server/setup/status";

type Database = typeof Db;

/**
 * Defaults that mirror the settings page so the wizard doesn't ship with
 * its own private opinions. Kept here (vs imported from the settings
 * router) so the wizard stays decoupled from `mutationProcedure` and the
 * trpc/auth import chain — the test suite can't pull `next-auth` in.
 */
export const DEFAULT_GITHUB_LABEL = "GitHub";
export const DEFAULT_GITHUB_SCOPES = "read:user user:email repo";
export const DEFAULT_AZURE_DEVOPS_LABEL = "Azure DevOps";
export const DEFAULT_AZURE_DEVOPS_SCOPES =
  "499b84ac-1321-427f-aa17-267ca6975798/.default offline_access";
export const DEFAULT_OPENAI_LABEL = "OpenAI";
export const DEFAULT_OPENAI_MODEL = "gpt-5";
export const DEFAULT_OPENAI_GUARDRAIL_LABEL = "OpenAI guardrail";
export const DEFAULT_OPENAI_GUARDRAIL_MODEL = "gpt-5-nano";

const LLM_ROLES = ["chat", "guardrail"] as const;
const LlmRole = z.enum(LLM_ROLES);

const PriceCentsPerMtok = z.number().min(0).max(1_000_000).nullable();

const GithubInput = z
  .object({
    label: z.string().min(1).max(80).default(DEFAULT_GITHUB_LABEL),
    clientId: z.string().min(1).max(200),
    clientSecret: z.string().min(1).max(500),
    scopes: z.string().max(500).default(DEFAULT_GITHUB_SCOPES),
    /** GitHub Enterprise base URL — blank means github.com. */
    baseUrl: z.string().max(500).default(""),
  })
  .nullable();

const AzureDevopsInput = z
  .object({
    label: z.string().min(1).max(80).default(DEFAULT_AZURE_DEVOPS_LABEL),
    clientId: z.string().min(1).max(200),
    clientSecret: z.string().min(1).max(500),
    scopes: z.string().max(500).default(DEFAULT_AZURE_DEVOPS_SCOPES),
    /** Entra tenant id (UUID) — required so `auth-build.ts` can resolve the OAuth endpoints. */
    tenantId: z.string().min(1).max(200),
  })
  .nullable();

/**
 * One LLM row staged by the wizard. The wizard only knows about OpenAI
 * (the only wired adapter) so `kind` is implicit; `role` decides whether
 * the row feeds the agent loop (`chat`) or the guardrail classifier
 * (`guardrail`). Bootstrap may receive multiple entries — typically one
 * per role — and creates them in order, skipping any (kind, role) pair
 * that already has a row in the deployment.
 */
const OpenAiInput = z.object({
  role: LlmRole.default("chat"),
  label: z.string().min(1).max(80).default(DEFAULT_OPENAI_LABEL),
  apiKey: z.string().min(1).max(500),
  /** Free-text model name — falls back to a role-appropriate default if blank. */
  model: z.string().max(120).default(""),
  /** Optional override for Azure OpenAI / proxies / Foundry. Blank = api.openai.com. */
  baseUrl: z.string().max(500).default(""),
  /** USD per million tokens × 100, matches LlmProvider columns. Null = unknown / unlogged. */
  inputPriceCentsPerMtok: PriceCentsPerMtok.default(null),
  outputPriceCentsPerMtok: PriceCentsPerMtok.default(null),
});

export const BootstrapInput = z
  .object({
    github: GithubInput.default(null),
    azureDevops: AzureDevopsInput.default(null),
    /**
     * Zero or more LLM rows to seed. The wizard typically submits one
     * `chat` row and optionally one `guardrail` row, but the shape allows
     * for future expansion (multiple chat models in one go, etc.). Cap at
     * 8 to keep bootstrap from accidentally batching huge writes — beyond
     * that, the operator should use the regular settings panel.
     */
    llms: z.array(OpenAiInput).max(8).default([]),
  })
  .refine((value) => value.github !== null || value.azureDevops !== null, {
    message: "At least one OAuth provider is required to finish setup.",
  })
  .refine(
    (value) => {
      const seen = new Set<string>();
      for (const llm of value.llms) {
        const key = `openai:${llm.role}`;
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
 * flip the sticky bit at the end. Idempotent against "user filled in
 * GitHub once, came back to add Azure" — but rejects outright once
 * `setup.complete` is true to stop a stale tab from silently
 * re-bootstrapping a running deployment.
 */
export async function applyBootstrap(
  db: Database,
  input: BootstrapInputType,
): Promise<SetupStatus> {
  const before = await getSetupStatus(db);
  if (before.complete) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Setup is already complete. Use the settings page to add more providers.",
    });
  }

  logger.info(
    {
      github: input.github !== null,
      azureDevops: input.azureDevops !== null,
      llmCount: input.llms.length,
    },
    "setup: bootstrap start",
  );

  if (input.github) {
    const existing = await db.oauthProviderConfig.findFirst({ where: { kind: "github" } });
    if (!existing) {
      await db.oauthProviderConfig.create({
        data: {
          kind: "github",
          label: input.github.label.trim() || DEFAULT_GITHUB_LABEL,
          clientId: input.github.clientId.trim(),
          clientSecret: encryptSecret(input.github.clientSecret),
          scopes: input.github.scopes.trim() || DEFAULT_GITHUB_SCOPES,
          baseUrl: input.github.baseUrl.trim(),
          enabled: true,
        },
      });
      logger.info({ kind: "github" }, "setup: oauth provider created");
    } else {
      logger.info({ kind: "github" }, "setup: oauth provider already exists; skipping");
    }
  }

  if (input.azureDevops) {
    const existing = await db.oauthProviderConfig.findFirst({ where: { kind: "azure_devops" } });
    if (!existing) {
      const tenant = input.azureDevops.tenantId.trim();
      await db.oauthProviderConfig.create({
        data: {
          kind: "azure_devops",
          label: input.azureDevops.label.trim() || DEFAULT_AZURE_DEVOPS_LABEL,
          clientId: input.azureDevops.clientId.trim(),
          clientSecret: encryptSecret(input.azureDevops.clientSecret),
          scopes: input.azureDevops.scopes.trim() || DEFAULT_AZURE_DEVOPS_SCOPES,
          baseUrl: "",
          metadata: { tenant },
          enabled: true,
        },
      });
      logger.info({ kind: "azure_devops" }, "setup: oauth provider created");
    } else {
      logger.info({ kind: "azure_devops" }, "setup: oauth provider already exists; skipping");
    }
  }

  for (const llm of input.llms) {
    // Skip if a row already exists for this (kind, role) — the wizard is
    // idempotent against returning operators who configured one role
    // earlier and are now adding the other.
    const existing = await db.llmProvider.findFirst({
      where: { kind: "openai", role: llm.role },
    });
    if (existing) {
      logger.info(
        { kind: "openai", role: llm.role },
        "setup: llm provider already exists; skipping",
      );
      continue;
    }
    // First row of this role in the deployment becomes its `isDefault`,
    // so the chat / guardrail resolvers have something to dispatch to
    // without further admin work. Roles default independently.
    const anyForRole = await db.llmProvider.count({ where: { role: llm.role } });
    const fallbackLabel =
      llm.role === "guardrail" ? DEFAULT_OPENAI_GUARDRAIL_LABEL : DEFAULT_OPENAI_LABEL;
    const fallbackModel =
      llm.role === "guardrail" ? DEFAULT_OPENAI_GUARDRAIL_MODEL : DEFAULT_OPENAI_MODEL;
    await db.llmProvider.create({
      data: {
        kind: "openai",
        role: llm.role,
        label: llm.label.trim() || fallbackLabel,
        apiKey: encryptSecret(llm.apiKey),
        model: llm.model.trim() || fallbackModel,
        baseUrl: llm.baseUrl.trim(),
        inputPriceCentsPerMtok: llm.inputPriceCentsPerMtok,
        outputPriceCentsPerMtok: llm.outputPriceCentsPerMtok,
        isDefault: anyForRole === 0,
        enabled: true,
      },
    });
    logger.info(
      { kind: "openai", role: llm.role, isDefault: anyForRole === 0 },
      "setup: llm provider created",
    );
  }

  // Re-read so the sticky bit flips in the same DB session and the
  // caller can `router.refresh()` straight into a redirect.
  const after = await getSetupStatus(db);
  logger.info({ complete: after.complete }, "setup: bootstrap complete");
  return after;
}
