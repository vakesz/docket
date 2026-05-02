import { relations, sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { ProjectId, ProviderItemId, UserId } from "@/core/types";
import { fkUuid, pkUuid } from "@/db/columns";
import { users } from "@/db/schema/auth";
import { projects } from "@/db/schema/projects";

// Pinning a providerItemId that is temporarily outside the active scope is
// valid; the render join just quietly excludes that row until the next sync
// re-adds it. So the FK target is the (projectId, providerItemId) tuple via
// a soft string match, not a hard FK to Item.id.

export const watchlistEntries = pgTable(
  "watchlist_entries",
  {
    id: pkUuid(),
    userId: fkUuid<UserId>(() => users.id, "cascade"),
    projectId: fkUuid<ProjectId>(() => projects.id, "cascade"),
    providerItemId: text().$type<ProviderItemId>().notNull(),
    pinnedAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("watchlist_user_project_provider_item_idx").on(
      t.userId,
      t.projectId,
      t.providerItemId,
    ),
    index("watchlist_user_pinned_at_idx").on(t.userId, sql`${t.pinnedAt} DESC`),
  ],
);

export const watchlistEntriesRelations = relations(watchlistEntries, ({ one }) => ({
  user: one(users, { fields: [watchlistEntries.userId], references: [users.id] }),
  project: one(projects, {
    fields: [watchlistEntries.projectId],
    references: [projects.id],
  }),
}));
