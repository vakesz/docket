import { relations } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ProjectId, UserId } from "@/core/types";
import { fkUuid, pkUuid, timestamps } from "@/db/columns";

// `users.defaultProjectId` is a soft reference to `projects.id`, not an FK.
// A bidirectional FK (users.defaultProjectId → projects.id alongside
// projects.ownerUserId → users.id) creates a TS inference cycle that
// collapses both tables to `any`. The redirect logic already tolerates a
// stale `defaultProjectId` — `firstMembershipFallback` re-falls-back to the
// first project the user belongs to and clears the stale id on the next
// write — so we skip the cascade enforcement and let app code handle it.
export const users = pgTable(
  "users",
  {
    id: pkUuid<UserId>(),
    name: text(),
    email: text().notNull().unique(),
    emailVerified: timestamp({ withTimezone: true, mode: "date" }),
    image: text(),
    defaultProjectId: uuid().$type<ProjectId>(),
    ...timestamps(),
  },
  (t) => [index("users_default_project_id_idx").on(t.defaultProjectId)],
);

// The Drizzle Auth.js adapter's typed schema expects exact TS keys: `userId`,
// `provider`, `providerAccountId` (camelCase) but `refresh_token`,
// `access_token`, `expires_at`, `token_type`, `id_token`, `session_state`
// (snake_case). The `casing: "snake_case"` config in `drizzle.config.ts`
// only affects DB column names, not TS keys, so we declare these properties
// with the exact names the adapter type checks for.
export const accounts = pgTable(
  "accounts",
  {
    id: pkUuid(),
    userId: fkUuid<UserId>(() => users.id, "cascade"),
    type: text().notNull(),
    provider: text().notNull(),
    providerAccountId: text().notNull(),
    refresh_token: text(),
    access_token: text(),
    expires_at: integer(),
    token_type: text(),
    scope: text(),
    id_token: text(),
    session_state: text(),
  },
  (t) => [
    uniqueIndex("accounts_provider_account_idx").on(t.provider, t.providerAccountId),
    index("accounts_user_id_idx").on(t.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    sessionToken: text().notNull().primaryKey(),
    userId: fkUuid<UserId>(() => users.id, "cascade"),
    expires: timestamp({ withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text().notNull(),
    token: text().notNull().unique(),
    expires: timestamp({ withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// `usersRelations` defining the `defaultProject` edge lives in
// `src/db/schema/projects.ts` (alongside the FK constraint), again to keep
// `auth.ts` free of `projects` imports.

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));
