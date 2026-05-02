// Single resolver for both LLM roles. Each level filters `role` + `enabled`,
// so a chat row can never resolve when the caller asked for guardrail and
// vice versa — the role split is enforced here, not at every call site.

import "server-only";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { llmProviders } from "@/db/schema";
import type { LlmProvider } from "@/db/schema/types";

export const LLM_ROLES = ["chat", "guardrail"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

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
  db: Db,
  role: LlmRole,
  pinnedIds: ReadonlyArray<string | null | undefined>,
): Promise<LlmProvider | null> {
  for (const id of pinnedIds) {
    if (!id) continue;
    const row = await db.query.llmProviders.findFirst({
      where: and(
        eq(llmProviders.id, id),
        eq(llmProviders.role, role),
        eq(llmProviders.enabled, true),
      ),
    });
    if (row) return row;
  }
  const flagged = await db.query.llmProviders.findFirst({
    where: and(
      eq(llmProviders.role, role),
      eq(llmProviders.isDefault, true),
      eq(llmProviders.enabled, true),
    ),
    orderBy: [desc(llmProviders.updatedAt)],
  });
  if (flagged) return flagged;
  return (
    (await db.query.llmProviders.findFirst({
      where: and(eq(llmProviders.role, role), eq(llmProviders.enabled, true)),
      orderBy: [desc(llmProviders.updatedAt)],
    })) ?? null
  );
}
