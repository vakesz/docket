import { relations, sql } from "drizzle-orm";
import { check, index, pgTable, text } from "drizzle-orm/pg-core";
import type { ProjectId } from "@/core/types";
import { emptyTextArray, fkUuid, pkUuid, timestamps } from "@/db/columns";
import { projects } from "@/db/schema/projects";

export type MemorySource = "user" | "agent";

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: pkUuid(),
    projectId: fkUuid<ProjectId>(() => projects.id, "cascade"),
    title: text().notNull(),
    body: text().notNull().default(""),
    tags: emptyTextArray(),
    // 'user' | 'agent' — informational; both are equally durable.
    source: text().$type<MemorySource>().notNull().default("user"),
    ...timestamps(),
  },
  (t) => [
    check("memory_entries_source_check", sql`${t.source} IN ('user', 'agent')`),
    index("memory_entries_project_updated_at_idx").on(t.projectId, sql`${t.updatedAt} DESC`),
  ],
);

export const memoryEntriesRelations = relations(memoryEntries, ({ one }) => ({
  project: one(projects, {
    fields: [memoryEntries.projectId],
    references: [projects.id],
  }),
}));
