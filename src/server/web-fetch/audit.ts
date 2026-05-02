/**
 * Append-only audit writer for the web_fetch tool.
 *
 * Every web_fetch call — successful or denied — writes one row to the
 * `web_fetch_events` table. The status string is open-ended so future
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
import type { ProjectId, UserId } from "@/core/types";
import type { Db } from "@/db";
import { webFetchEvents } from "@/db/schema";
import { logger } from "@/server/logger";

export type WebFetchAuditRow = {
  projectId: ProjectId;
  userId: UserId | null;
  url: string;
  status: string;
  contentType: string | null;
  bytes: number;
  errorMessage: string | null;
  /**
   * HTML-cleanup outcome. null = cleaning didn't apply (raw=true, non-HTML
   * response, denial before fetch). true = HTML successfully converted to
   * markdown. false = cleaning was attempted but failed/produced empty
   * output and the tool fell back to the raw body.
   */
  cleaned?: boolean | null;
  /** UTF-8 byte length of the cleaned markdown when `cleaned === true`. */
  cleanedBytes?: number | null;
  /** Reason cleaning failed when `cleaned === false`. */
  cleanError?: string | null;
};

export async function recordWebFetchEvent(db: Db, row: WebFetchAuditRow): Promise<void> {
  try {
    await db.insert(webFetchEvents).values({
      projectId: row.projectId,
      userId: row.userId,
      url: row.url,
      status: row.status,
      contentType: row.contentType,
      bytes: row.bytes,
      errorMessage: row.errorMessage,
      cleaned: row.cleaned ?? null,
      cleanedBytes: row.cleanedBytes ?? null,
      cleanError: row.cleanError ?? null,
    });
  } catch (err) {
    logger.warn(
      { err, projectId: row.projectId, status: row.status },
      "web_fetch audit write failed",
    );
  }
}
