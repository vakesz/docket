import { relations, sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ProjectId, ProposalId, UserId } from "@/core/types";
import { emptyJsonbObject, fkUuid, optionalFkUuid, pkUuid } from "@/db/columns";
import { users } from "@/db/schema/auth";
import { projects } from "@/db/schema/projects";

// Append-only record of every confirmed/rejected proposal so the project
// owner can answer "who did what when" without reading server logs.
// `userId` uses `set null` on user delete so the audit trail outlives the
// user. `proposalId` is a soft string reference (no FK) — proposals may be
// purged for retention while audit rows survive.

export const audits = pgTable(
  "audits",
  {
    id: pkUuid(),
    projectId: fkUuid<ProjectId>(() => projects.id, "cascade"),
    userId: optionalFkUuid<UserId>(() => users.id, "set null"),
    // 'proposal.confirm' | 'proposal.confirm.failed' | 'proposal.reject'.
    // Open-extensibility — free-text so future actions can be added without a
    // schema change.
    action: text().notNull(),
    proposalId: uuid().$type<ProposalId>(),
    payload: emptyJsonbObject<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("audits_project_created_at_idx").on(t.projectId, sql`${t.createdAt} DESC`),
    index("audits_project_action_idx").on(t.projectId, t.action),
    // Retention sweep + global eligible-count both filter by `createdAt`
    // alone (no projectId).
    index("audits_created_at_idx").on(t.createdAt),
  ],
);

export const auditsRelations = relations(audits, ({ one }) => ({
  project: one(projects, { fields: [audits.projectId], references: [projects.id] }),
  user: one(users, { fields: [audits.userId], references: [users.id] }),
}));
