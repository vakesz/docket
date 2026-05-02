import { relations, sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ProjectId, UserId } from "@/core/types";
import { fkUuid, optionalFkUuid, pkUuid } from "@/db/columns";
import { users } from "@/db/schema/auth";
import { llmProviders } from "@/db/schema/llm";

export type ProjectMembershipRole = "viewer" | "member" | "approver";

export const projects = pgTable(
  "projects",
  {
    id: pkUuid<ProjectId>(),
    name: text().notNull(),
    // URL slug derived from `name` via `slugify`. Globally unique — two
    // projects can't share a slug regardless of owner. Recomputed on rename.
    slug: text().notNull().unique(),
    description: text().notNull().default(""),
    // 'github' | 'azure_devops' | future kinds. Matches OauthProviderConfig.kind.
    providerKind: text().notNull(),
    // Per-provider scope payload (e.g. `{ owner, repo }` for GitHub,
    // `{ organization, project }` for AzDO). Schemas live in each provider
    // module's spec; this column doesn't validate.
    providerScope: jsonb().$type<Record<string, unknown>>().notNull(),
    // Project-level chat LLM choice; falls back to the most-recently-updated
    // enabled chat row when null. Per-conversation override on
    // Conversation.llmProviderIdOverride.
    defaultLlmProviderId: optionalFkUuid(() => llmProviders.id, "set null"),
    // Project-level guardrail LLM choice; null disables LLM-judge guardrail
    // for the project. FK targets a guardrail row.
    defaultGuardrailProviderId: optionalFkUuid(() => llmProviders.id, "set null"),
    // Project-level sampling temperature. Null → adapter default.
    defaultTemperature: doublePrecision(),
    // Owner has implicit membership; explicit memberships go through
    // ProjectMembership. Owner can delete the project; members cannot.
    ownerUserId: fkUuid<UserId>(() => users.id, "cascade"),
    createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
    archivedAt: timestamp({ withTimezone: true, mode: "date" }),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("projects_owner_archived_idx").on(t.ownerUserId, t.archivedAt),
    index("projects_provider_kind_idx").on(t.providerKind),
    index("projects_default_llm_idx").on(t.defaultLlmProviderId),
    index("projects_default_guardrail_idx").on(t.defaultGuardrailProviderId),
  ],
);

export const projectMemberships = pgTable(
  "project_memberships",
  {
    id: pkUuid(),
    projectId: fkUuid<ProjectId>(() => projects.id, "cascade"),
    userId: fkUuid<UserId>(() => users.id, "cascade"),
    role: text().$type<ProjectMembershipRole>().notNull().default("member"),
    createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    check("project_memberships_role_check", sql`${t.role} IN ('viewer', 'member', 'approver')`),
    uniqueIndex("project_memberships_project_user_idx").on(t.projectId, t.userId),
    index("project_memberships_user_idx").on(t.userId),
  ],
);

// `usersRelations` lives here so `auth.ts` doesn't have to import `projects`
// at the column-definition level — that import is what creates the TS
// inference cycle.
export const usersRelations = relations(users, ({ many, one }) => ({
  defaultProject: one(projects, {
    fields: [users.defaultProjectId],
    references: [projects.id],
    relationName: "userDefaultProject",
  }),
  ownedProjects: many(projects, { relationName: "projectOwner" }),
  memberships: many(projectMemberships),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  owner: one(users, {
    fields: [projects.ownerUserId],
    references: [users.id],
    relationName: "projectOwner",
  }),
  defaultLlm: one(llmProviders, {
    fields: [projects.defaultLlmProviderId],
    references: [llmProviders.id],
    relationName: "projectDefaultLlm",
  }),
  defaultGuardrail: one(llmProviders, {
    fields: [projects.defaultGuardrailProviderId],
    references: [llmProviders.id],
    relationName: "projectDefaultGuardrail",
  }),
  memberships: many(projectMemberships),
}));

export const projectMembershipsRelations = relations(projectMemberships, ({ one }) => ({
  project: one(projects, {
    fields: [projectMemberships.projectId],
    references: [projects.id],
  }),
  user: one(users, {
    fields: [projectMemberships.userId],
    references: [users.id],
  }),
}));
