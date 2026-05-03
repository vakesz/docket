import { relations, sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ProjectId, UserId } from "@/core/types";
import { fkUuid, optionalFkUuid, pkUuid } from "@/db/columns";
import { users } from "@/db/schema/auth";
import { projects } from "@/db/schema/projects";

// Append-only log of every URL the agent's `web_fetch` tool pulled on behalf
// of a user. Separate from `audits` so the
// "audit writes only from the proposal executor" invariant stays intact.

export const webFetchEvents = pgTable(
  "web_fetch_events",
  {
    id: pkUuid(),
    projectId: fkUuid<ProjectId>(() => projects.id, "cascade"),
    // `set null` on user delete so the trail outlives the user. Same shape as
    // `audits.userId`.
    userId: optionalFkUuid<UserId>(() => users.id, "set null"),
    url: text().notNull(),
    // 'ok' | 'error' | 'denied_disabled' | 'denied_url' |
    // 'denied_host_allowlist' | 'denied_host_metadata' |
    // 'denied_host_unresolved' | 'denied_redirect' | 'denied_type' |
    // 'denied_size'. Open-extensibility — free-text so the tool can grow new
    // failure modes without a migration.
    status: text().notNull(),
    contentType: text(),
    bytes: integer().notNull().default(0),
    errorMessage: text(),
    // null = cleaning didn't apply (raw=true, non-HTML response, or denial
    // before fetch). true = HTML was successfully converted to markdown.
    // false = cleaning was attempted but failed/produced empty output and the
    // tool fell back to the raw body.
    cleaned: boolean(),
    cleanedBytes: integer(),
    cleanError: text(),
    createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("web_fetch_events_project_created_at_idx").on(t.projectId, sql`${t.createdAt} DESC`),
    index("web_fetch_events_project_status_idx").on(t.projectId, t.status),
  ],
);

export const webFetchEventsRelations = relations(webFetchEvents, ({ one }) => ({
  project: one(projects, {
    fields: [webFetchEvents.projectId],
    references: [projects.id],
  }),
  user: one(users, { fields: [webFetchEvents.userId], references: [users.id] }),
}));
