// Bootstrap minimum is one enabled OAuth provider — without it nobody
// can sign in. The LLM provider is tracked for display but no longer
// required to flip the sticky `setup.complete` bit; operators can wire it
// later via /settings. The bit stays true after the first observation,
// even if rows later get disabled — clear the Setting row by hand to revert.

import "server-only";
import type { db as Db } from "@/server/db";
import { loadGlobalSetting, upsertGlobalSetting } from "@/server/settings/effective";

type Database = typeof Db;

export type SetupStatus = {
  /** Sticky-bit OR computed: at least one OAuth row exists. */
  complete: boolean;
  /** At least one enabled `LlmProvider` row exists. Tracked for the wizard's status display only. */
  hasLlm: boolean;
  /** At least one enabled `OauthProviderConfig` row exists — this is what gates `complete`. */
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
  if (hasOauth && !sticky) {
    // First observation flips the bit so subsequent requests skip the
    // count() round-trips. Best-effort: a write race between two
    // simultaneous requests is harmless (both write `true`).
    await upsertGlobalSetting(db, "setup.complete", true);
  }
  return { complete: sticky || hasOauth, hasLlm, hasOauth };
}
