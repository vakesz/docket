/**
 * Guardrail registry — selectGuardrailFor(project).
 *
 * Picks the right guardrail adapter (or chain) for a project based on:
 *   - the project's `guardrail.enabled` and `guardrail.kind` settings,
 *   - the `LlmProvider` row referenced by `Project.defaultGuardrailProviderId`
 *     (or, when unset, the most-recent enabled `role='guardrail'` row).
 *
 * Resolution rules — pattern adapter is always available (no provider
 * row needed). The LLM-judge adapter requires a guardrail provider row;
 * if the kind is `llm-judge` or `composite` and no row is found, we fall
 * back to pattern only (and log).
 *
 * Role enforcement: the resolver explicitly filters
 * `where: { role: 'guardrail', enabled: true }`. A chat row can never
 * accidentally power a guardrail (and vice versa — the chat-side
 * `selectAdapterFor` filters `role: 'chat'`).
 */

import "server-only";
import { CompositeGuardrail } from "@/agent/guardrail/composite";
import type { JudgeClient } from "@/agent/guardrail/judge-client";
import { loadJudgePrompts } from "@/agent/guardrail/judge-prompts-loader";
import { LlmJudgeGuardrail } from "@/agent/guardrail/llm-judge";
import { NoopGuardrail } from "@/agent/guardrail/noop";
import { PatternGuardrail } from "@/agent/guardrail/pattern";
import type { Guardrail, GuardrailKind } from "@/agent/guardrail/types";
import { AnthropicJudgeClient } from "@/agent/llm/anthropic";
import { OpenAiJudgeClient } from "@/agent/llm/openai";
import type { LlmKind } from "@/agent/llm/types";
import type { LlmProvider, Project } from "@/db/generated/client";
import type { db as Db } from "@/server/db";
import { logger } from "@/server/logger";
import { decryptSecret } from "@/server/secrets/encryption";

type Database = typeof Db;

export type GuardrailSettings = {
  enabled: boolean;
  kind: GuardrailKind;
  blockOnInjection: boolean;
  blockOffTopic: boolean;
  scopeCheckEnabled: boolean;
  outputCheckEnabled: boolean;
};

export type GuardrailContext = {
  project: Pick<Project, "id" | "defaultGuardrailProviderId">;
  settings: GuardrailSettings;
};

export async function selectGuardrailFor(db: Database, ctx: GuardrailContext): Promise<Guardrail> {
  if (!ctx.settings.enabled) return new NoopGuardrail();

  switch (ctx.settings.kind) {
    case "noop":
      return new NoopGuardrail();
    case "pattern":
      return new PatternGuardrail({ blockOnInjection: ctx.settings.blockOnInjection });
    case "llm-judge": {
      const judge = await tryBuildLlmJudge(db, ctx);
      if (judge) return judge;
      logger.warn(
        { projectId: ctx.project.id },
        "guardrail: llm-judge configured but no guardrail provider row; falling back to pattern",
      );
      return new PatternGuardrail({ blockOnInjection: ctx.settings.blockOnInjection });
    }
    case "composite": {
      const pattern = new PatternGuardrail({ blockOnInjection: ctx.settings.blockOnInjection });
      const judge = await tryBuildLlmJudge(db, ctx);
      if (judge) return new CompositeGuardrail([pattern, judge]);
      logger.warn(
        { projectId: ctx.project.id },
        "guardrail: composite configured but no guardrail provider row; using pattern only",
      );
      return pattern;
    }
    default: {
      const exhaustive: never = ctx.settings.kind;
      logger.error({ kind: exhaustive }, "guardrail: unsupported kind");
      return new NoopGuardrail();
    }
  }
}

async function tryBuildLlmJudge(
  db: Database,
  ctx: GuardrailContext,
): Promise<LlmJudgeGuardrail | null> {
  const row = await resolveGuardrailProvider(db, ctx.project);
  if (!row) return null;
  if (!row.model || row.model.length === 0) {
    logger.warn(
      { projectId: ctx.project.id, providerId: row.id, label: row.label },
      "guardrail: provider row has no model set; falling back to pattern",
    );
    return null;
  }
  const client = buildJudgeClient(row);
  if (!client) {
    logger.warn(
      { projectId: ctx.project.id, providerId: row.id, kind: row.kind, label: row.label },
      "guardrail: no JudgeClient registered for provider kind; falling back to pattern",
    );
    return null;
  }
  const prompts = await loadJudgePrompts(db);
  return new LlmJudgeGuardrail({
    client,
    label: row.label,
    prompts,
    scopeCheckEnabled: ctx.settings.scopeCheckEnabled,
    outputCheckEnabled: ctx.settings.outputCheckEnabled,
    blockOffTopic: ctx.settings.blockOffTopic,
    blockOnInjection: ctx.settings.blockOnInjection,
    inputPriceCentsPerMtok: decimalToNumber(row.inputPriceCentsPerMtok),
    outputPriceCentsPerMtok: decimalToNumber(row.outputPriceCentsPerMtok),
  });
}

/**
 * Build the vendor-specific `JudgeClient` for a guardrail provider row. The
 * dispatch mirrors the chat-side `selectAdapterFor`: every `LlmKind` lives
 * in its own adapter file under `src/agent/llm/<kind>.ts`, and the arch
 * test `llm-kinds-have-adapters.test.ts` keeps this switch in lockstep with
 * the `LLM_KINDS` tuple. Returning `null` means the operator wired a kind
 * we haven't shipped a JudgeClient for yet — the registry falls back to
 * pattern in that case.
 */
function buildJudgeClient(row: LlmProvider): JudgeClient | null {
  const apiKey = decryptSecret(row.apiKey);
  const kind = row.kind as LlmKind;
  switch (kind) {
    case "openai":
      return new OpenAiJudgeClient({
        apiKey,
        model: row.model,
        ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
      });
    case "anthropic":
      return new AnthropicJudgeClient({
        apiKey,
        model: row.model,
        ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
      });
    default: {
      const exhaustive: never = kind;
      void exhaustive;
      return null;
    }
  }
}

function decimalToNumber(value: LlmProvider["inputPriceCentsPerMtok"]): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : Number(value);
}

async function resolveGuardrailProvider(
  db: Database,
  project: Pick<Project, "defaultGuardrailProviderId">,
): Promise<LlmProvider | null> {
  if (project.defaultGuardrailProviderId) {
    const row = await db.llmProvider.findFirst({
      where: { id: project.defaultGuardrailProviderId, role: "guardrail", enabled: true },
    });
    if (row) return row;
  }
  // No project pin → fall back to the deployment-wide guardrail default
  // (`role='guardrail' AND isDefault`). If no row carries the flag, take the
  // most-recently-updated enabled guardrail row so the layer keeps working
  // before the operator has marked one explicitly.
  const flagged = await db.llmProvider.findFirst({
    where: { role: "guardrail", isDefault: true, enabled: true },
  });
  if (flagged) return flagged;
  return db.llmProvider.findFirst({
    where: { role: "guardrail", enabled: true },
    orderBy: [{ updatedAt: "desc" }],
  });
}
