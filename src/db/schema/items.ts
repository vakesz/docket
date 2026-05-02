import { relations } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type {
  ItemId,
  ItemKind,
  ItemState,
  ProjectId,
  ProviderItemId,
  Reactions,
} from "@/core/types";
import { emptyJsonbObject, emptyTextArray, fkUuid, pkUuid } from "@/db/columns";
import { projects } from "@/db/schema/projects";

export type ItemCiSummary = {
  state: "success" | "failure" | "pending";
  url: string | null;
};

export const items = pgTable(
  "items",
  {
    id: pkUuid<ItemId>(),
    projectId: fkUuid<ProjectId>(() => projects.id, "cascade"),
    // Provider-native id (e.g. "acme/web#42" for GitHub, "1234" for AzDO).
    // Stable across syncs; the surrogate `id` is the FK target so renames at
    // the provider don't ripple.
    providerItemId: text().$type<ProviderItemId>().notNull(),
    // Canonical kind: ItemKind in src/core/types.ts. Open-extensibility — no
    // CHECK constraint.
    kind: text().$type<ItemKind>().notNull(),
    title: text().notNull(),
    description: text().notNull().default(""),
    // Canonical state: ItemState in src/core/types.ts. Open-extensibility — no
    // CHECK constraint.
    state: text().$type<ItemState>().notNull(),
    // Canonical plural assignee list. Providers without multi-assignee fill
    // `[assignee]` when assigned, `[]` otherwise.
    assignees: emptyTextArray(),
    // Optional reviewer logins (GitHub PR requested_reviewers, etc).
    reviewers: emptyTextArray(),
    // Provider-native ids of items linked to this one (cross-references,
    // AzDO relations).
    linkedItemIds: emptyTextArray(),
    author: text(),
    // Parent's providerItemId, not the surrogate uuid. Resolved at query time.
    parentId: text().$type<ProviderItemId>(),
    tags: emptyTextArray(),
    // Catch-all bag for provider-native fields that don't have typed slots
    // yet. Items already surface reactions, assignees, reviewers, milestone,
    // iteration, area, ciSummary as typed columns — providerRaw is for the
    // long tail beyond those.
    providerRaw: emptyJsonbObject<Record<string, unknown>>(),
    url: text(),
    repositoryUrl: text(),
    // Provider-side creation timestamp ("Opened" date). Nullable because
    // legacy/cached rows may pre-date the field and some providers don't
    // always surface it.
    createdAt: timestamp({ withTimezone: true, mode: "date" }),
    updatedAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    closedAt: timestamp({ withTimezone: true, mode: "date" }),
    syncedAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    archived: boolean().notNull().default(false),
    // Reaction summary keyed by ReactionKind → integer count. Null when the
    // provider doesn't model reactions.
    reactions: jsonb().$type<Reactions | null>(),
    // GitHub: milestone title. AzDO: null.
    milestone: text(),
    // AzDO: System.IterationPath. GitHub: null.
    iteration: text(),
    // AzDO: System.AreaPath. GitHub: null.
    area: text(),
    // `{ state: "success"|"failure"|"pending", url: string|null }` — null when
    // the provider doesn't surface CI on this item.
    ciSummary: jsonb().$type<ItemCiSummary | null>(),
  },
  (t) => [
    uniqueIndex("items_project_provider_item_idx").on(t.projectId, t.providerItemId),
    index("items_project_kind_archived_idx").on(t.projectId, t.kind, t.archived),
    index("items_project_updated_at_idx").on(t.projectId, t.updatedAt),
    index("items_project_parent_id_idx").on(t.projectId, t.parentId),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: pkUuid(),
    itemId: fkUuid<ItemId>(() => items.id, "cascade"),
    providerCommentId: text().notNull(),
    author: text().notNull(),
    body: text().notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    // Last-touched timestamp from the provider. Sync uses this as a
    // skip-rewrite cursor: comments whose providerUpdatedAt matches the
    // cached row are not re-upserted.
    providerUpdatedAt: timestamp({ withTimezone: true, mode: "date" }),
    edited: boolean().notNull().default(false),
    reactions: jsonb().$type<Reactions | null>(),
  },
  (t) => [
    uniqueIndex("comments_item_provider_comment_idx").on(t.itemId, t.providerCommentId),
    index("comments_item_created_at_idx").on(t.itemId, t.createdAt),
  ],
);

export const itemsRelations = relations(items, ({ one, many }) => ({
  project: one(projects, { fields: [items.projectId], references: [projects.id] }),
  comments: many(comments),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  item: one(items, { fields: [comments.itemId], references: [items.id] }),
}));
