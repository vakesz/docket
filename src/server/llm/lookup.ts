// Single resolver for both LLM roles. Each level filters `role` + `enabled`,
// so a chat row can never resolve when the caller asked for guardrail and
// vice versa — the role split is enforced here, not at every call site.

import "server-only";
import type { LlmProvider } from "@/db/generated/client";
import type { db as Db } from "@/server/db";

export const LLM_ROLES = ["chat", "guardrail"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

type Database = typeof Db;

/**
 * Resolve the active `LlmProvider` row for a given role:
 *   pinnedIds (in order, first match wins)
 *     → role default flagged with `isDefault`
 *     → most-recently-updated enabled row in the role
 *
 * Each candidate is filtered on `role` + `enabled: true` so a disabled pin
 * gracefully falls through to the next level instead of erroring.
 */
export async function resolveProviderForRole(
  db: Database,
  role: LlmRole,
  pinnedIds: ReadonlyArray<string | null | undefined>,
): Promise<LlmProvider | null> {
  for (const id of pinnedIds) {
    if (!id) continue;
    const row = await db.llmProvider.findFirst({ where: { id, role, enabled: true } });
    if (row) return row;
  }
  const flagged = await db.llmProvider.findFirst({
    where: { role, isDefault: true, enabled: true },
    orderBy: [{ updatedAt: "desc" }],
  });
  if (flagged) return flagged;
  return db.llmProvider.findFirst({
    where: { role, enabled: true },
    orderBy: [{ updatedAt: "desc" }],
  });
}
