import { relations } from "drizzle-orm";
import { boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import type { ProjectId, StateBucket, UserId } from "@/core/types";
import { emptyJsonbObject, emptyTextArray, fkUuid, pkUuid, timestamps } from "@/db/columns";
import { users } from "@/db/schema/auth";
import { projects } from "@/db/schema/projects";

// Saved views — per-user, per-project named visual filters. Every narrowing
// dimension is a *visual* (post-cache) filter — sync pulls everything the
// credentials see, and `view-filter.ts` decides what renders.

export type SavedViewFacets = Record<string, string>;

export const savedViews = pgTable(
  "saved_views",
  {
    id: pkUuid(),
    userId: fkUuid<UserId>(() => users.id, "cascade"),
    projectId: fkUuid<ProjectId>(() => projects.id, "cascade"),
    // Display name shown in the picker. Unique per (user, project).
    name: text().notNull(),
    // 'open' | 'closed' | 'all' — over the canonical ItemState enum.
    stateBucket: text().$type<StateBucket>().notNull().default("open"),
    // Usernames to include. An empty string in the list means "unassigned".
    assignees: emptyTextArray(),
    // Per-provider facet selections — `{ facetKey: expectedValue }`. The
    // `ProviderSpec.facetMatcher` interprets each facet.
    facets: emptyJsonbObject<SavedViewFacets>(),
    // One row per (user, project) may have isDefault=true; the application
    // enforces it via clear-then-flip rather than a partial unique index.
    isDefault: boolean().notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("saved_views_user_project_name_idx").on(t.userId, t.projectId, t.name),
    index("saved_views_user_project_default_idx").on(t.userId, t.projectId, t.isDefault),
  ],
);

export const savedViewsRelations = relations(savedViews, ({ one }) => ({
  user: one(users, { fields: [savedViews.userId], references: [users.id] }),
  project: one(projects, { fields: [savedViews.projectId], references: [projects.id] }),
}));
