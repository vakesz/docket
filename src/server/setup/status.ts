/**
 * Setup-status read model.
 *
 * The middleware (Phase 11c) and the (eventually) admin wizard both need
 * the same answer: *has this deployment finished its initial bootstrap?*
 * That answer is "yes" the first time the DB has at least one enabled
 * `LlmProvider` AND at least one enabled `OauthProviderConfig` row.
 *
 * To keep middleware fast and stop us from re-deriving on every request,
 * the first observation flips a sticky `setup.complete` global Setting to
 * true. Once flipped, the bit stays true even if rows are later disabled
 * — operators who genuinely want to revert can clear the row by hand.
 *
 * The flag also lets the local `bin/seed-dev.ts` short-circuit on a
 * production environment that already finished its wizard, per the
 * Phase 11 spec ("Seed is gated by NODE_ENV !== 'production' and by the
 * absence of setup_complete = true").
 */

import "server-only";
import type { db as Db } from "@/server/db";
import { encodeSettingValue } from "@/server/settings/catalog";
import { loadGlobalSetting } from "@/server/settings/effective";

type Database = typeof Db;

export type SetupStatus = {
  /** Sticky-bit OR computed: at least one LLM + one OAuth row exist. */
  complete: boolean;
  /** At least one enabled `LlmProvider` row exists. */
  hasLlm: boolean;
  /** At least one enabled `OauthProviderConfig` row exists. */
  hasOauth: boolean;
};

export async function getSetupStatus(db: Database): Promise<SetupStatus> {
  const [llmCount, oauthCount, sticky] = await Promise.all([
    db.llmProvider.count({ where: { enabled: true } }),
    db.oauthProviderConfig.count({ where: { enabled: true } }),
    loadGlobalSetting(db, "setup.complete"),
  ]);
  const hasLlm = llmCount > 0;
  const hasOauth = oauthCount > 0;
  const computed = hasLlm && hasOauth;
  if (computed && !sticky) {
    // First observation flips the bit so subsequent requests skip the
    // count() round-trips. Best-effort: a write race between two
    // simultaneous requests is harmless (both write `true`).
    await persistComplete(db);
  }
  return { complete: sticky || computed, hasLlm, hasOauth };
}

async function persistComplete(db: Database): Promise<void> {
  // Postgres treats nulls as unconstrained in compound unique indexes, so
  // a global Setting (userId/projectId both null) needs find-then-write
  // rather than upsert. Mirrors `settings/router.ts:update`.
  const value = encodeSettingValue("setup.complete", true);
  const existing = await db.setting.findFirst({
    where: { key: "setup.complete", scope: "global", userId: null, projectId: null },
    select: { id: true },
  });
  if (existing) {
    await db.setting.update({ where: { id: existing.id }, data: { value } });
    return;
  }
  await db.setting.create({
    data: { key: "setup.complete", value, scope: "global" },
  });
}
