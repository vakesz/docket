import { relations, sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ProjectId, ProposalId, ProviderItemId, UserId } from "@/core/types";
import { fkUuid, pkUuid, timestamps } from "@/db/columns";
import { users } from "@/db/schema/auth";
import { projects } from "@/db/schema/projects";

export type ProposalStatus = "pending" | "confirmed" | "rejected" | "expired";
export type ProposalOrigin = "ui" | "agent";

export const proposals = pgTable(
  "proposals",
  {
    id: pkUuid<ProposalId>(),
    projectId: fkUuid<ProjectId>(() => projects.id, "cascade"),
    userId: fkUuid<UserId>(() => users.id, "cascade"),
    // One of: state_change, description_patch, attachment_upload, item_create,
    // comment_add, tags_change, reaction_toggle, memory_write, memory_delete.
    // Source of truth is src/core/proposal-types.ts. Open-extensibility — no
    // CHECK constraint.
    kind: text().notNull(),
    // 'ui' | 'agent'. Stamped at stage time so `maybeAutoAccept` can
    // distinguish a human button click from an LLM-tool stage.
    origin: text().$type<ProposalOrigin>().notNull().default("agent"),
    // Provider-native item id this proposal targets, when relevant.
    providerItemId: text().$type<ProviderItemId>(),
    // Full proposal payload (Item snapshot + the change). Type narrowing
    // happens in `src/server/proposals/`.
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    status: text().$type<ProposalStatus>().notNull().default("pending"),
    confirmedAt: timestamp({ withTimezone: true, mode: "date" }),
    executedAt: timestamp({ withTimezone: true, mode: "date" }),
    errorMessage: text(),
    advisory: text(),
    ...timestamps(),
  },
  (t) => [
    check(
      "proposals_status_check",
      sql`${t.status} IN ('pending', 'confirmed', 'rejected', 'expired')`,
    ),
    check("proposals_origin_check", sql`${t.origin} IN ('ui', 'agent')`),
    index("proposals_project_status_created_at_idx").on(
      t.projectId,
      t.status,
      sql`${t.createdAt} DESC`,
    ),
    index("proposals_user_status_idx").on(t.userId, t.status),
  ],
);

export const proposalsRelations = relations(proposals, ({ one }) => ({
  project: one(projects, { fields: [proposals.projectId], references: [projects.id] }),
  user: one(users, { fields: [proposals.userId], references: [users.id] }),
}));
