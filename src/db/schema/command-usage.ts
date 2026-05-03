import { relations, sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import type { ProjectId, UserId } from "@/core/types";
import { fkUuid, optionalFkUuid, pkUuid } from "@/db/columns";
import { users } from "@/db/schema/auth";
import { projects } from "@/db/schema/projects";

// Command palette usage counter — floats recently-used commands to the
// top of the picker.
//
// `nullsNotDistinct()` makes the (userId, projectId, commandId) tuple
// unique even when projectId is NULL (global commands). Without it,
// Postgres treats every NULL as distinct and the same global command
// could spawn duplicate rows under concurrent bumps.
export const commandUsage = pgTable(
  "command_usage",
  {
    id: pkUuid(),
    userId: fkUuid<UserId>(() => users.id, "cascade"),
    projectId: optionalFkUuid<ProjectId>(() => projects.id, "cascade"),
    // Stable command id (e.g. "items.new", "memory.write"). Display labels
    // can change without invalidating the counter.
    commandId: text().notNull(),
    lastUsedAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
    usageCount: integer().notNull().default(1),
  },
  (t) => [
    unique("command_usage_user_project_command_unique")
      .on(t.userId, t.projectId, t.commandId)
      .nullsNotDistinct(),
    index("command_usage_user_last_used_at_idx").on(t.userId, sql`${t.lastUsedAt} DESC`),
  ],
);

export const commandUsageRelations = relations(commandUsage, ({ one }) => ({
  user: one(users, { fields: [commandUsage.userId], references: [users.id] }),
  project: one(projects, { fields: [commandUsage.projectId], references: [projects.id] }),
}));
