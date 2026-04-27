/**
 * Append-only audit writer for the web_fetch tool.
 *
 * Every web_fetch call — successful or denied — writes one row to the
 * `WebFetchEvent` table. The status string is open-ended so future
 * deny reasons (`denied_size`, `denied_type`, …) can land without a
 * migration.
 *
 * Writes are best-effort: a DB failure here must not bring down the
 * agent loop, so the helper swallows errors. In practice the inbound
 * tool call has already passed `projectScopedMutationProcedure`-style
 * checks at the loop boundary, so a failure here is a DB outage we'll
 * see in the application logs separately.
 */

import "server-only";
import type { db as Db } from "@/server/db";
import { logger } from "@/server/logger";

export type WebFetchAuditRow = {
  projectId: string;
  userId: string | null;
  url: string;
  status: string;
  contentType: string | null;
  bytes: number;
  errorMessage: string | null;
};

export async function recordWebFetchEvent(db: typeof Db, row: WebFetchAuditRow): Promise<void> {
  try {
    await db.webFetchEvent.create({ data: row });
  } catch (err) {
    logger.warn(
      { err, projectId: row.projectId, status: row.status },
      "web_fetch audit write failed",
    );
  }
}
