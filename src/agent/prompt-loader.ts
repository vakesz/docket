/**
 * Resolve the agent's system prompts from global settings, falling back to
 * the source-baked defaults when an override row is absent. Empty strings
 * also fall back so an admin who clears the field doesn't end up with a
 * model staring at no instructions.
 */

import "server-only";
import { DEFAULT_PROMPTS, type ResolvedPrompts } from "@/agent/prompt";
import type { ItemKind } from "@/core/types";
import type { db as Db } from "@/server/db";
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

export async function loadPrompts(db: typeof Db): Promise<ResolvedPrompts> {
  const [systemBase, epic, feature, story, task, bug] = await Promise.all([
    loadGlobalSetting(db, "prompt.system-base"),
    loadGlobalSetting(db, KIND_KEYS.epic),
    loadGlobalSetting(db, KIND_KEYS.feature),
    loadGlobalSetting(db, KIND_KEYS.story),
    loadGlobalSetting(db, KIND_KEYS.task),
    loadGlobalSetting(db, KIND_KEYS.bug),
  ]);
  return {
    systemBase: systemBase.trim().length > 0 ? systemBase : DEFAULT_PROMPTS.systemBase,
    kindPrompts: {
      epic: epic.trim().length > 0 ? epic : DEFAULT_PROMPTS.kindPrompts.epic,
      feature: feature.trim().length > 0 ? feature : DEFAULT_PROMPTS.kindPrompts.feature,
      story: story.trim().length > 0 ? story : DEFAULT_PROMPTS.kindPrompts.story,
      task: task.trim().length > 0 ? task : DEFAULT_PROMPTS.kindPrompts.task,
      bug: bug.trim().length > 0 ? bug : DEFAULT_PROMPTS.kindPrompts.bug,
    },
  };
}
