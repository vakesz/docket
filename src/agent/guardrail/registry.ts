// LLM-judge requires a `role: 'guardrail'` LlmProvider row. If the kind is
// `llm-judge` or `composite` and no matching row resolves, fall back to
// pattern-only (and log). The chat-side resolver filters `role: 'chat'` —
// the role split is what keeps a chat row from accidentally powering the
// guardrail and vice versa.

import "server-only";
import { CompositeGuardrail } from "@/agent/guardrail/composite";
import type { JudgeClient } from "@/agent/guardrail/judge-client";
import { loadJudgePrompts } from "@/agent/guardrail/judge-prompts-loader";
import { LlmJudgeGuardrail } from "@/agent/guardrail/llm-judge";
import { NoopGuardrail } from "@/agent/guardrail/noop";
import { PatternGuardrail } from "@/agent/guardrail/pattern";
import type { Guardrail, GuardrailKind } from "@/agent/guardrail/types";
import { AnthropicJudgeClient } from "@/agent/llm/anthropic";
import { decimalToNumber } from "@/agent/llm/decimal";
import { OpenAiJudgeClient } from "@/agent/llm/openai";
import { isLlmKind, type LlmKind } from "@/agent/llm/types";
import type { Db } from "@/db";
import type { LlmProvider, Project } from "@/db/schema/types";
import { resolveProviderForRole } from "@/server/llm/lookup";
import { logger } from "@/server/logger";
import { decryptSecret } from "@/server/secrets/encryption";

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

export async function selectGuardrailFor(db: Db, ctx: GuardrailContext): Promise<Guardrail> {
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

async function tryBuildLlmJudge(db: Db, ctx: GuardrailContext): Promise<LlmJudgeGuardrail | null> {
  const row = await resolveProviderForRole(db, "guardrail", [
    ctx.project.defaultGuardrailProviderId,
  ]);
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
  if (!isLlmKind(row.kind)) {
    logger.warn(
      { providerId: row.id, kind: row.kind, label: row.label },
      "guardrail: provider row has unknown LLM kind",
    );
    return null;
  }
  const apiKey = decryptSecret(row.apiKey);
  const kind: LlmKind = row.kind;
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
