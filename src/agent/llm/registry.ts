/**
 * LLM registry — selectAdapterFor.
 *
 * Picks the right `LlmProvider` row for a project + optional override and
 * dispatches on `kind` to instantiate the matching adapter. At launch the
 * dispatch table has one entry (`openai`) plus a `default: throw` so a
 * misconfigured row fails loudly instead of silently.
 *
 * Resolution order (most specific first):
 *   1. `Conversation.llmProviderIdOverride` if provided (per-conversation pick)
 *   2. `Project.defaultLlmProviderId` (per-project pick)
 *   3. The `LlmProvider` row marked `isDefault = true` (global fallback)
 */

import "server-only";
import { OpenAiAdapter } from "@/agent/llm/openai";
import type { LlmAdapter } from "@/agent/llm/types";
import type { LlmProvider, Project } from "@/db/generated/client";
import type { db as Db } from "@/server/db";
import { decryptSecret } from "@/server/secrets/encryption";

type Database = typeof Db;

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

export type AdapterContext = {
  /** Project context — defines the per-project default. */
  project: Pick<Project, "id" | "defaultLlmProviderId">;
  /** Per-conversation override id, if set. */
  overrideId?: string | null;
};

export async function selectAdapterFor(db: Database, ctx: AdapterContext): Promise<LlmAdapter> {
  const row = await resolveProvider(db, ctx);
  if (!row) {
    throw new LlmConfigError(
      "No LLM provider configured. Add a row in Settings → LLM providers and mark one as default.",
    );
  }
  if (!row.enabled) {
    throw new LlmConfigError(`LLM provider '${row.label}' is disabled.`);
  }
  return buildAdapter(row);
}

export function buildAdapter(row: LlmProvider): LlmAdapter {
  // `apiKey` is encrypted at rest with `SECRETS_KEY`. Legacy plaintext rows
  // decrypt to themselves, so this is a no-op until the operator rolls a key.
  const apiKey = decryptSecret(row.apiKey);
  switch (row.kind) {
    case "openai":
      return new OpenAiAdapter({
        apiKey,
        label: row.label,
        model: row.model || undefined,
        baseUrl: row.baseUrl || undefined,
      });
    default:
      throw new LlmConfigError(
        `Unsupported LLM kind '${row.kind}'. Only 'openai' has an adapter today; add a sibling adapter under src/agent/llm/ for new vendors.`,
      );
  }
}

async function resolveProvider(db: Database, ctx: AdapterContext): Promise<LlmProvider | null> {
  if (ctx.overrideId) {
    const row = await db.llmProvider.findUnique({ where: { id: ctx.overrideId } });
    if (row) return row;
  }
  if (ctx.project.defaultLlmProviderId) {
    const row = await db.llmProvider.findUnique({
      where: { id: ctx.project.defaultLlmProviderId },
    });
    if (row) return row;
  }
  return db.llmProvider.findFirst({
    where: { isDefault: true, enabled: true },
    orderBy: [{ updatedAt: "desc" }],
  });
}
