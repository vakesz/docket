import { relations, sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import type { ProjectId, UserId } from "@/core/types";
import { optionalFkUuid, pkUuid, timestamps } from "@/db/columns";
import { users } from "@/db/schema/auth";
import { projects } from "@/db/schema/projects";

export type SettingScope = "global" | "user" | "project";

// Generic key-value settings (per-user, per-project, or global). Three
// partial unique indexes enforce per-scope uniqueness — Postgres treats NULL
// as distinct in plain uniques, so a four-column `unique(key, user_id,
// project_id, scope)` would be a no-op for the global / partial-NULL scopes.

export const settings = pgTable(
  "settings",
  {
    id: pkUuid(),
    // Kebab-cased key (e.g. "ui.theme", "agent.compaction-threshold").
    key: text().notNull(),
    // Stringified value. JSON encoding decided per-key by the consumer.
    value: text().notNull(),
    scope: text().$type<SettingScope>().notNull(),
    userId: optionalFkUuid<UserId>(() => users.id, "cascade"),
    projectId: optionalFkUuid<ProjectId>(() => projects.id, "cascade"),
    // True when `value` is AES-256-GCM ciphertext (`enc:v1:<iv>:<ct+tag>`)
    // keyed by SECRETS_KEY. Set per-key by the consumer.
    encrypted: boolean().notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    check("settings_scope_check", sql`${t.scope} IN ('global', 'user', 'project')`),
    index("settings_scope_key_idx").on(t.scope, t.key),
    uniqueIndex("settings_key_global_idx")
      .on(t.key)
      .where(sql`${t.userId} IS NULL AND ${t.projectId} IS NULL`),
    uniqueIndex("settings_key_user_idx")
      .on(t.key, t.userId)
      .where(sql`${t.userId} IS NOT NULL AND ${t.projectId} IS NULL`),
    uniqueIndex("settings_key_project_idx")
      .on(t.key, t.projectId)
      .where(sql`${t.userId} IS NULL AND ${t.projectId} IS NOT NULL`),
  ],
);

export const settingsRelations = relations(settings, ({ one }) => ({
  user: one(users, { fields: [settings.userId], references: [users.id] }),
  project: one(projects, { fields: [settings.projectId], references: [projects.id] }),
}));
