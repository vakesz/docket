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
const orDefault = (override: string, fallback: string): string =>
  override.trim().length > 0 ? override : fallback;

export async function loadPrompts(db: Db): Promise<ResolvedPrompts> {
  const [systemBase, epic, feature, story, task, bug] = await Promise.all([
    loadGlobalSetting(db, "prompt.system-base"),
    loadGlobalSetting(db, KIND_KEYS.epic),
    loadGlobalSetting(db, KIND_KEYS.feature),
    loadGlobalSetting(db, KIND_KEYS.story),
    loadGlobalSetting(db, KIND_KEYS.task),
    loadGlobalSetting(db, KIND_KEYS.bug),
  ]);
  return {
    systemBase: orDefault(systemBase, DEFAULT_PROMPTS.systemBase),
    kindPrompts: {
      epic: orDefault(epic, DEFAULT_PROMPTS.kindPrompts.epic),
      feature: orDefault(feature, DEFAULT_PROMPTS.kindPrompts.feature),
      story: orDefault(story, DEFAULT_PROMPTS.kindPrompts.story),
      task: orDefault(task, DEFAULT_PROMPTS.kindPrompts.task),
      bug: orDefault(bug, DEFAULT_PROMPTS.kindPrompts.bug),
    },
  };
}
