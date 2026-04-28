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
import { LlmJudgeGuardrail } from "@/agent/guardrail/llm-judge";
import { NoopGuardrail } from "@/agent/guardrail/noop";
import { PatternGuardrail } from "@/agent/guardrail/pattern";
import type { Guardrail, GuardrailKind } from "@/agent/guardrail/types";
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
  const apiKey = decryptSecret(row.apiKey);
  return new LlmJudgeGuardrail({
    apiKey,
    label: row.label,
    model: row.model,
    baseUrl: row.baseUrl || undefined,
    scopeCheckEnabled: ctx.settings.scopeCheckEnabled,
    outputCheckEnabled: ctx.settings.outputCheckEnabled,
    blockOffTopic: ctx.settings.blockOffTopic,
    blockOnInjection: ctx.settings.blockOnInjection,
    inputPriceCentsPerMtok: decimalToNumber(row.inputPriceCentsPerMtok),
    outputPriceCentsPerMtok: decimalToNumber(row.outputPriceCentsPerMtok),
  });
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
