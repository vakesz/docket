// Every lookup filters `role: 'chat'` — a guardrail row must never resolve
// here. The disjoint guardrail resolver lives in
// `src/agent/guardrail/registry.ts`.

import "server-only";
import { AnthropicAdapter } from "@/agent/llm/anthropic";
import { decimalToNumber } from "@/agent/llm/decimal";
import { OpenAiAdapter } from "@/agent/llm/openai";
import type { LlmAdapter } from "@/agent/llm/types";
import type { Db } from "@/db";
import type { LlmProvider, Project } from "@/db/schema/types";
import { resolveProviderForRole } from "@/server/llm/lookup";
import { decryptSecret } from "@/server/secrets/encryption";

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

export async function selectAdapterFor(db: Db, ctx: AdapterContext): Promise<LlmAdapter> {
  const row = await resolveProviderForRole(db, "chat", [
    ctx.overrideId,
    ctx.project.defaultLlmProviderId,
  ]);
  if (!row) {
    throw new LlmConfigError(
      "No LLM provider configured. Add a row in Settings → LLM providers and mark one as default.",
    );
  }
  // Defense-in-depth: `resolveProviderForRole` already filters `enabled: true`,
  // but if it ever stops doing so we want a clean error rather than a panic
  // deeper in the adapter.
  if (!row.enabled) {
    throw new LlmConfigError(`LLM provider '${row.label}' is disabled.`);
  }
  return buildAdapter(row, { defaultTemperature: ctx.project.defaultTemperature ?? null });
}

function buildAdapter(
  row: LlmProvider,
  opts: { defaultTemperature?: number | null } = {},
): LlmAdapter {
  const apiKey = decryptSecret(row.apiKey);
  const inputPriceCentsPerMtok = decimalToNumber(row.inputPriceCentsPerMtok);
  const outputPriceCentsPerMtok = decimalToNumber(row.outputPriceCentsPerMtok);
  switch (row.kind) {
    case "openai":
      return new OpenAiAdapter({
        apiKey,
        label: row.label,
        ...(row.model ? { model: row.model } : {}),
        ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
        ...(opts.defaultTemperature !== undefined && opts.defaultTemperature !== null
          ? { defaultTemperature: opts.defaultTemperature }
          : {}),
        inputPriceCentsPerMtok,
        outputPriceCentsPerMtok,
      });
    case "anthropic":
      return new AnthropicAdapter({
        apiKey,
        label: row.label,
        ...(row.model ? { model: row.model } : {}),
        ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
        ...(opts.defaultTemperature !== undefined && opts.defaultTemperature !== null
          ? { defaultTemperature: opts.defaultTemperature }
          : {}),
        inputPriceCentsPerMtok,
        outputPriceCentsPerMtok,
      });
    default:
      throw new LlmConfigError(
        `Unsupported LLM kind '${row.kind}'. Add a sibling adapter under src/agent/llm/ for new vendors.`,
      );
  }
}
