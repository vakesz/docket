/**
 * LLM registry — selectAdapterFor.
 *
 * Picks the right chat-role `LlmProvider` row for a project + optional
 * override and dispatches on `kind` to instantiate the matching adapter.
 * At launch the dispatch table has one entry (`openai`) plus a
 * `default: throw` so a misconfigured row fails loudly instead of silently.
 *
 * Resolution order (most specific first):
 *   1. `Conversation.llmProviderIdOverride` (per-conversation pick)
 *   2. `Project.defaultLlmProviderId`        (per-project pick)
 *   3. `role='chat'` + `isDefault=true`      (deployment-wide chat default)
 *
 * Every lookup filters `role: 'chat'` so a guardrail row can never resolve
 * here. The disjoint guardrail resolver lives in
 * `src/agent/guardrail/registry.ts`.
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
  project: Pick<Project, "id" | "defaultLlmProviderId" | "defaultTemperature">;
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
  return buildAdapter(row, { defaultTemperature: ctx.project.defaultTemperature ?? null });
}

/**
 * Kinds for which an adapter is wired today. Keep in sync with the `switch`
 * below — `llm-kinds-have-adapters.test.ts` enforces this at the LLM_KINDS
 * level; this constant just lets the error path report what the registry
 * actually supports without grepping the file.
 */
const SUPPORTED_KINDS = ["openai"] as const;

export function buildAdapter(
  row: LlmProvider,
  opts: { defaultTemperature?: number | null } = {},
): LlmAdapter {
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
        defaultTemperature: opts.defaultTemperature ?? undefined,
        inputPriceCentsPerMtok: row.inputPriceCentsPerMtok?.toNumber() ?? null,
        outputPriceCentsPerMtok: row.outputPriceCentsPerMtok?.toNumber() ?? null,
      });
    default:
      throw new LlmConfigError(
        `Unsupported LLM kind '${row.kind}'. Wired kinds: ${SUPPORTED_KINDS.join(", ")}. Add a sibling adapter under src/agent/llm/ for new vendors.`,
      );
  }
}

async function resolveProvider(db: Database, ctx: AdapterContext): Promise<LlmProvider | null> {
  // Every level filters `enabled: true` so a disabled override / pin
  // gracefully falls through to the next level instead of erroring out
  // mid-turn. Same policy as `src/server/llm/lookup.ts`. The `enabled`
  // check on `selectAdapterFor` is now defense-in-depth — by the time a
  // row reaches it, this function has already filtered.
  if (ctx.overrideId) {
    const row = await db.llmProvider.findFirst({
      where: { id: ctx.overrideId, role: "chat", enabled: true },
    });
    if (row) return row;
  }
  if (ctx.project.defaultLlmProviderId) {
    const row = await db.llmProvider.findFirst({
      where: { id: ctx.project.defaultLlmProviderId, role: "chat", enabled: true },
    });
    if (row) return row;
  }
  const flagged = await db.llmProvider.findFirst({
    where: { role: "chat", isDefault: true, enabled: true },
    orderBy: [{ updatedAt: "desc" }],
  });
  if (flagged) return flagged;
  return db.llmProvider.findFirst({
    where: { role: "chat", enabled: true },
    orderBy: [{ updatedAt: "desc" }],
  });
}
