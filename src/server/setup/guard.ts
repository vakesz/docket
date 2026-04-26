/**
 * Page-level guard for the bootstrap state.
 *
 * Root server components call `requireSetupComplete()` as their first
 * statement; if the deployment hasn't finished its initial setup (no LLM
 * provider OR no OAuth provider), the helper throws `redirect()` to the
 * `/setup-required` page. Once the sticky `setup.complete` Setting has
 * flipped (see `./status.ts`), this is one indexed lookup — cheap enough
 * to run on every render.
 *
 * Why per-page rather than middleware: Next 16's middleware runs on the
 * Edge runtime, where Prisma's PgPool adapter doesn't work, and the
 * Node-runtime alternative (`proxy.ts`) is still settling. Server-component
 * gating is unconditionally Node and uses the same DB instance as the
 * rest of the app — no second client, no synchronization concerns.
 *
 * The setup-required page itself MUST NOT call this guard, or the
 * redirect will bounce against itself.
 */

import "server-only";
import { redirect } from "next/navigation";
import { db } from "@/server/db";
import { getSetupStatus, type SetupStatus } from "@/server/setup/status";

export async function requireSetupComplete(): Promise<SetupStatus> {
  const status = await getSetupStatus(db);
  if (!status.complete) {
    redirect("/setup-required");
  }
  return status;
}
