import { relations } from "drizzle-orm";
import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ProjectId } from "@/core/types";
import { projects } from "@/db/schema/projects";

// One row per project — the project id doubles as the primary key, mirroring
// the Prisma `model SyncCursor { projectId String @id ... }` shape.

export const syncCursors = pgTable("sync_cursors", {
  projectId: uuid()
    .$type<ProjectId>()
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  watermark: timestamp({ withTimezone: true, mode: "date" }),
  lastFullSyncAt: timestamp({ withTimezone: true, mode: "date" }),
  updatedAt: timestamp({ withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const syncCursorsRelations = relations(syncCursors, ({ one }) => ({
  project: one(projects, {
    fields: [syncCursors.projectId],
    references: [projects.id],
  }),
}));
