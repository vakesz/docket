import { relations, sql } from "drizzle-orm";
import { index, pgTable, text } from "drizzle-orm/pg-core";
import type { ProjectId } from "@/core/types";
import { emptyTextArray, fkUuid, pkUuid, timestamps } from "@/db/columns";
import { projects } from "@/db/schema/projects";

export const sourceDocs = pgTable(
  "source_docs",
  {
    id: pkUuid(),
    projectId: fkUuid<ProjectId>(() => projects.id, "cascade"),
    title: text().notNull(),
    // Free-text category ("requirements", "runbook", "design"). Empty allowed.
    kind: text().notNull().default(""),
    uri: text().notNull().default(""),
    body: text().notNull().default(""),
    tags: emptyTextArray(),
    ...timestamps(),
  },
  (t) => [
    index("source_docs_project_updated_at_idx").on(t.projectId, sql`${t.updatedAt} DESC`),
    index("source_docs_project_kind_idx").on(t.projectId, t.kind),
  ],
);

export const sourceDocsRelations = relations(sourceDocs, ({ one }) => ({
  project: one(projects, { fields: [sourceDocs.projectId], references: [projects.id] }),
}));
