/**
 * Guardrail settings loader — pulls per-project knobs from the catalog
 * and folds them into the shape `selectGuardrailFor` expects. Mirrors
 * `loadCompactionSettings` in the conversations module.
 */

import "server-only";
import type { GuardrailSettings } from "@/agent/guardrail/registry";
import type { ProjectId } from "@/core/types";
import type { Db } from "@/db";
import { loadProjectSetting } from "@/server/settings/effective";

export type { GuardrailSettings };

export async function loadGuardrailSettings(
  db: Db,
  projectId: ProjectId,
): Promise<GuardrailSettings> {
  const [enabled, kind, blockOnInjection, blockOffTopic, scopeCheckEnabled, outputCheckEnabled] =
    await Promise.all([
      loadProjectSetting(db, projectId, "guardrail.enabled"),
      loadProjectSetting(db, projectId, "guardrail.kind"),
      loadProjectSetting(db, projectId, "guardrail.block-on-injection"),
      loadProjectSetting(db, projectId, "guardrail.block-off-topic"),
      loadProjectSetting(db, projectId, "guardrail.scope-check-enabled"),
      loadProjectSetting(db, projectId, "guardrail.output-check-enabled"),
    ]);
  return {
    enabled,
    kind,
    blockOnInjection,
    blockOffTopic,
    scopeCheckEnabled,
    outputCheckEnabled,
  };
}
