import { relations } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ProjectId } from "@/core/types";
import { fkUuid, pkUuid } from "@/db/columns";
import { projects } from "@/db/schema/projects";

export const suggestions = pgTable(
  "suggestions",
  {
    id: pkUuid(),
    projectId: fkUuid<ProjectId>(() => projects.id, "cascade"),
    // Free-text category — the suggestion service decides what these mean.
    // 'duplicate' | 'related' | 'transition' at minimum.
    kind: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
    // When the user clicks "ignore" — kept for analytics rather than deleted.
    dismissedAt: timestamp({ withTimezone: true, mode: "date" }),
  },
  (t) => [index("suggestions_project_kind_dismissed_idx").on(t.projectId, t.kind, t.dismissedAt)],
);

export const suggestionsRelations = relations(suggestions, ({ one }) => ({
  project: one(projects, { fields: [suggestions.projectId], references: [projects.id] }),
}));
