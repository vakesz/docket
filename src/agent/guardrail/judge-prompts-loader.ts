/**
 * Resolve the LLM-judge guardrail's system prompts from global settings,
 * falling back to the source-baked defaults when an override row is
 * absent. Empty strings also fall back so an admin who clears the field
 * doesn't end up with the judge staring at no instructions.
 */

import "server-only";
import { DEFAULT_JUDGE_PROMPTS, type ResolvedJudgePrompts } from "@/agent/guardrail/judge-prompts";
import type { db as Db } from "@/server/db";
import { loadGlobalSetting } from "@/server/settings/effective";

export async function loadJudgePrompts(db: typeof Db): Promise<ResolvedJudgePrompts> {
  const [injection, scope, output] = await Promise.all([
    loadGlobalSetting(db, "prompt.guardrail.injection"),
    loadGlobalSetting(db, "prompt.guardrail.scope"),
    loadGlobalSetting(db, "prompt.guardrail.output-safety"),
  ]);
  return {
    injectionSystem:
      injection.trim().length > 0 ? injection : DEFAULT_JUDGE_PROMPTS.injectionSystem,
    scopeSystem: scope.trim().length > 0 ? scope : DEFAULT_JUDGE_PROMPTS.scopeSystem,
    outputSafetySystem:
      output.trim().length > 0 ? output : DEFAULT_JUDGE_PROMPTS.outputSafetySystem,
  };
}
