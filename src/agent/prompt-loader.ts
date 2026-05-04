/**
 * Resolve the agent's system prompts from global settings, falling back to
 * the source-baked defaults when an override row is absent. Empty strings
 * also fall back so an admin who clears the field doesn't end up with a
 * model staring at no instructions.
 */

import "server-only";
import { DEFAULT_PROMPTS, type ResolvedPrompts } from "@/agent/prompt";
import type { ItemKind } from "@/core/types";
import type { Db } from "@/db";
import { loadGlobalSetting } from "@/server/settings/effective";

const KIND_KEYS: Record<
  ItemKind,
  | "prompt.kind.epic"
  | "prompt.kind.feature"
  | "prompt.kind.story"
  | "prompt.kind.task"
  | "prompt.kind.bug"
> = {
  epic: "prompt.kind.epic",
  feature: "prompt.kind.feature",
  story: "prompt.kind.story",
  task: "prompt.kind.task",
  bug: "prompt.kind.bug",
};

// Empty-or-whitespace overrides fall back so an admin who clears a field
// doesn't leave the model staring at no instructions.
async function loadOrDefault<K extends Parameters<typeof loadGlobalSetting>[1]>(
  db: Db,
  key: K,
  fallback: string,
): Promise<string> {
  const value = await loadGlobalSetting(db, key);
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

export async function loadPrompts(db: Db): Promise<ResolvedPrompts> {
  const [systemBase, epic, feature, story, task, bug] = await Promise.all([
    loadOrDefault(db, "prompt.system-base", DEFAULT_PROMPTS.systemBase),
    loadOrDefault(db, KIND_KEYS.epic, DEFAULT_PROMPTS.kindPrompts.epic),
    loadOrDefault(db, KIND_KEYS.feature, DEFAULT_PROMPTS.kindPrompts.feature),
    loadOrDefault(db, KIND_KEYS.story, DEFAULT_PROMPTS.kindPrompts.story),
    loadOrDefault(db, KIND_KEYS.task, DEFAULT_PROMPTS.kindPrompts.task),
    loadOrDefault(db, KIND_KEYS.bug, DEFAULT_PROMPTS.kindPrompts.bug),
  ]);
  return {
    systemBase,
    kindPrompts: { epic, feature, story, task, bug },
  };
}
