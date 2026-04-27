import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { db as Db } from "@/server/db";
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

const OpenAiInput = z
  .object({
    label: z.string().min(1).max(80).default(DEFAULT_OPENAI_LABEL),
    apiKey: z.string().min(1).max(500),
    /** Free-text model name — falls back to `gpt-5` if blank. */
    model: z.string().max(120).default(""),
    /** Optional override for Azure OpenAI / proxies / Foundry. Blank = api.openai.com. */
    baseUrl: z.string().max(500).default(""),
    /** USD per million tokens × 100, matches LlmProvider columns. Null = unknown / unlogged. */
    inputPriceCentsPerMtok: PriceCentsPerMtok.default(null),
    outputPriceCentsPerMtok: PriceCentsPerMtok.default(null),
  })
  .nullable();

export const BootstrapInput = z
  .object({
    github: GithubInput.default(null),
    azureDevops: AzureDevopsInput.default(null),
    openai: OpenAiInput.default(null),
  })
  .refine((value) => value.github !== null || value.azureDevops !== null, {
    message: "At least one OAuth provider is required to finish setup.",
  });

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
    }
  }

  if (input.azureDevops) {
    const existing = await db.oauthProviderConfig.findFirst({ where: { kind: "azure_devops" } });
    if (!existing) {
      await db.oauthProviderConfig.create({
        data: {
          kind: "azure_devops",
          label: input.azureDevops.label.trim() || DEFAULT_AZURE_DEVOPS_LABEL,
          clientId: input.azureDevops.clientId.trim(),
          clientSecret: encryptSecret(input.azureDevops.clientSecret),
          scopes: input.azureDevops.scopes.trim() || DEFAULT_AZURE_DEVOPS_SCOPES,
          baseUrl: input.azureDevops.tenantId.trim(),
          enabled: true,
        },
      });
    }
  }

  if (input.openai) {
    const existing = await db.llmProvider.findFirst({ where: { kind: "openai" } });
    if (!existing) {
      const anyOther = await db.llmProvider.count();
      await db.llmProvider.create({
        data: {
          kind: "openai",
          label: input.openai.label.trim() || DEFAULT_OPENAI_LABEL,
          apiKey: encryptSecret(input.openai.apiKey),
          model: input.openai.model.trim() || DEFAULT_OPENAI_MODEL,
          baseUrl: input.openai.baseUrl.trim(),
          inputPriceCentsPerMtok: input.openai.inputPriceCentsPerMtok,
          outputPriceCentsPerMtok: input.openai.outputPriceCentsPerMtok,
          isDefault: anyOther === 0,
          enabled: true,
        },
      });
    }
  }

  // Re-read so the sticky bit flips in the same DB session and the
  // caller can `router.refresh()` straight into a redirect.
  return getSetupStatus(db);
}
