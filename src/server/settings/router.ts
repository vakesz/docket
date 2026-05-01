/**
 * Settings API.
 *
 * Per-user and deployment-wide settings keyed off the `Setting` table.
 * Clients call `list` for user-scoped keys, `globalList` for deployment-wide
 * keys; `update`/`globalUpdate` write a single key, `reset`/`globalReset`
 * drop the row so the catalog default takes over.
 *
 * The catalog (`./catalog.ts`) is the single source of truth for what keys
 * exist, how they validate, and where they live (user / project / global).
 * The router refuses to touch any key not in the catalog so a typo can't
 * silently land a stray Setting row.
 */

import "server-only";
import { z } from "zod";
import { getBudgetStatus } from "@/server/billing/budget";
import { logger } from "@/server/logger";
import { pruneAuditOlderThan } from "@/server/proposals/executor";
import {
  decodeSettingValue,
  getSettingDef,
  SETTING_KEYS,
  SETTINGS_CATALOG,
  type SettingKey,
  type SettingScope,
  type SettingValue,
} from "@/server/settings/catalog";
import { loadGlobalSetting } from "@/server/settings/effective";
import {
  mutationProcedure,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  projectSlugSchema,
  protectedProcedure,
  router,
} from "@/server/trpc";

/**
 * Build a discriminated union over `(key, value)` pairs for one scope —
 * each branch pins `key` to the literal catalog id and `value` to that
 * key's catalog schema. The router can't be called with a wrong-scope
 * key (the union doesn't include it) or a malformed value (Zod parses it
 * against the per-key schema), so the procedure bodies don't carry a
 * scope check or a try/catch around encoding.
 *
 * `setup.complete` is excluded from the global union — it's a sticky
 * bootstrap flag, not a router-writable setting.
 */
/**
 * Mapped-type-derived discriminated union over `(key, value)` pairs for one
 * scope. The runtime schema is built dynamically from the catalog (so adding
 * a setting needs zero router edits), but the TS type is reconstructed here
 * so callers narrow on `key` and the per-key value type without `as never`.
 */
type ScopedKey<S extends SettingScope> = {
  [K in SettingKey]: (typeof SETTINGS_CATALOG)[K]["scope"] extends S ? K : never;
}[SettingKey];

type WritableScopedKey<S extends SettingScope> = Exclude<ScopedKey<S>, "setup.complete">;

type ScopedUpdateInput<S extends SettingScope> = {
  [K in WritableScopedKey<S>]: { key: K; value: SettingValue<K> };
}[WritableScopedKey<S>];

export type UserSettingUpdate = ScopedUpdateInput<"user">;
export type GlobalSettingUpdate = ScopedUpdateInput<"global">;
export type ProjectSettingUpdate = { projectSlug: string } & ScopedUpdateInput<"project">;

type UpdateOption = z.ZodObject<{ key: z.ZodLiteral<SettingKey>; value: z.ZodTypeAny }>;

/**
 * Build the per-scope `{ key, value }` discriminated-union schema. The cast
 * on the `discriminatedUnion` result is the one inherent bridge between the
 * dynamically-built runtime tuple and the statically-mapped `ScopedUpdateInput<S>`
 * type — Zod can't see through `SettingKey` → catalog-scope filtering.
 */
function buildScopedUpdateSchema<S extends SettingScope>(
  scope: S,
): z.ZodType<ScopedUpdateInput<S>> {
  const [first, ...rest] = SETTING_KEYS.filter(
    (k) => SETTINGS_CATALOG[k].scope === scope && k !== "setup.complete",
  ).map(
    (k): UpdateOption =>
      z.object({
        key: z.literal(k),
        value: SETTINGS_CATALOG[k].schema as z.ZodTypeAny,
      }),
  );
  if (!first) {
    throw new Error(`buildScopedUpdateSchema: no writable keys for scope '${scope}'`);
  }
  // The runtime union enumerates every catalog key for the scope, but the
  // generic `S` parameter is opaque to TS at this point — it can't prove the
  // dynamic key list matches `WritableScopedKey<S>`. The unknown bridge is
  // confined to this one helper; callers see a precise per-scope type.
  return z.discriminatedUnion("key", [first, ...rest]) as unknown as z.ZodType<
    ScopedUpdateInput<S>
  >;
}

const UserUpdateInput = buildScopedUpdateSchema("user");
const GlobalUpdateInput = buildScopedUpdateSchema("global");
// `projectSlugSchema.and(...)` returns a `ZodIntersection` whose output
// inference loses the discriminated-union arm because `.and()` on a
// `ZodType<T>` doesn't propagate `T` through the intersection's output.
// One cast on the result is the minimum bridge — the runtime parse still
// validates both sides; only the TS view is being patched.
const ProjectUpdateInput = projectSlugSchema.and(
  buildScopedUpdateSchema("project"),
) as z.ZodType<ProjectSettingUpdate>;

function scopedKeys(scope: SettingScope): SettingKey[] {
  return SETTING_KEYS.filter((k) => SETTINGS_CATALOG[k].scope === scope && k !== "setup.complete");
}

const UserKeyEnum = z.enum(scopedKeys("user") as [SettingKey, ...SettingKey[]]);
const GlobalKeyEnum = z.enum(scopedKeys("global") as [SettingKey, ...SettingKey[]]);
const ProjectKeyEnum = z.enum(scopedKeys("project") as [SettingKey, ...SettingKey[]]);

const UserResetInput = z.object({ key: UserKeyEnum });
const GlobalResetInput = z.object({ key: GlobalKeyEnum });
const ProjectResetInput = projectSlugSchema.extend({ key: ProjectKeyEnum });

export const settingsRouter = router({
  /**
   * Catalog metadata — exposed so the SPA can render the form without
   * hardcoding labels/descriptions client-side.
   */
  catalog: protectedProcedure.query(() => {
    return SETTING_KEYS.map((key) => {
      const def = getSettingDef(key);
      return {
        key: def.key,
        scope: def.scope,
        label: def.label,
        description: def.description,
        default: def.default,
      };
    });
  }),

  /**
   * Effective per-user settings for every catalog key. Catalog default is
   * substituted when no row exists; bad rows fall back to default and are
   * not surfaced as an error (the user shouldn't be locked out of the
   * settings page by a corrupt row).
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.userId;
    const userKeys = SETTING_KEYS.filter((k) => SETTINGS_CATALOG[k].scope === "user");
    const rows = await ctx.db.setting.findMany({
      where: { userId, scope: "user", key: { in: userKeys } },
      select: { key: true, value: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    return userKeys.map((key) => ({
      key,
      value: decodeSettingValue(key, byKey.get(key) ?? null),
    }));
  }),

  update: mutationProcedure.input(UserUpdateInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
    const encoded = JSON.stringify(input.value);
    // Prisma's `upsert` won't accept `null` in a compound-unique `where`,
    // and Postgres treats `null` columns in a unique as unconstrained — so
    // a per-user (projectId == null) Setting needs find-then-update/create.
    const existing = await ctx.db.setting.findFirst({
      where: { key: input.key, userId, projectId: null },
      select: { id: true },
    });
    if (existing) {
      return ctx.db.setting.update({ where: { id: existing.id }, data: { value: encoded } });
    }
    return ctx.db.setting.create({
      data: { key: input.key, value: encoded, scope: "user", userId },
    });
  }),

  reset: mutationProcedure.input(UserResetInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
    const def = getSettingDef(input.key);
    await ctx.db.setting.deleteMany({
      where: { key: input.key, userId, scope: "user" },
    });
    return { ok: true, value: def.default };
  }),

  /**
   * Effective deployment-wide settings. `setup.complete` is intentionally
   * excluded from the deployment surface — it's a sticky bootstrap flag,
   * not a user-tunable knob, and the rest of the app already manages it.
   */
  globalList: protectedProcedure.query(async ({ ctx }) => {
    const keys = SETTING_KEYS.filter(
      (k) => SETTINGS_CATALOG[k].scope === "global" && k !== "setup.complete",
    );
    const rows = await ctx.db.setting.findMany({
      where: { scope: "global", userId: null, projectId: null, key: { in: keys } },
      select: { key: true, value: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
    });
    // Postgres treats null in a unique index as unconstrained; if a duplicate
    // landed somehow, prefer the most recently updated row (matches
    // `loadGlobalSetting`).
    const byKey = new Map<string, string>();
    for (const r of rows) {
      if (!byKey.has(r.key)) byKey.set(r.key, r.value);
    }
    return keys.map((key) => ({
      key,
      value: decodeSettingValue(key, byKey.get(key) ?? null),
      label: getSettingDef(key).label,
      description: getSettingDef(key).description,
    }));
  }),

  globalUpdate: mutationProcedure.input(GlobalUpdateInput).mutation(async ({ ctx, input }) => {
    const encoded = JSON.stringify(input.value);
    const existing = await ctx.db.setting.findFirst({
      where: { key: input.key, scope: "global", userId: null, projectId: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    // Log every global setting change — they affect the whole deployment, are
    // rare, and the audit log only covers proposals. Operators reading logs
    // need to see who flipped read-only mode, retention windows, etc.
    logger.info(
      { actorUserId: ctx.userId, key: input.key, value: input.value },
      "settings: global setting changed",
    );
    if (existing) {
      return ctx.db.setting.update({ where: { id: existing.id }, data: { value: encoded } });
    }
    return ctx.db.setting.create({ data: { key: input.key, value: encoded, scope: "global" } });
  }),

  globalReset: mutationProcedure.input(GlobalResetInput).mutation(async ({ ctx, input }) => {
    const def = getSettingDef(input.key);
    await ctx.db.setting.deleteMany({
      where: { key: input.key, scope: "global", userId: null, projectId: null },
    });
    logger.info(
      { actorUserId: ctx.userId, key: input.key },
      "settings: global setting reset to default",
    );
    return { ok: true, value: def.default };
  }),

  /**
   * Effective project-scoped settings for the requested project. Returns
   * every project-scoped catalog key (catalog default substituted when the
   * row is missing or invalid).
   */
  projectList: projectScopedProcedure.input(projectSlugSchema).query(async ({ ctx }) => {
    const projectKeys = SETTING_KEYS.filter((k) => SETTINGS_CATALOG[k].scope === "project");
    const rows = await ctx.db.setting.findMany({
      where: {
        projectId: ctx.projectId,
        scope: "project",
        key: { in: projectKeys },
      },
      select: { key: true, value: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    return projectKeys.map((key) => ({
      key,
      value: decodeSettingValue(key, byKey.get(key) ?? null),
    }));
  }),

  projectUpdate: projectScopedMutationProcedure
    .input(ProjectUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const encoded = JSON.stringify(input.value);
      const existing = await ctx.db.setting.findFirst({
        where: { key: input.key, projectId: ctx.projectId, scope: "project", userId: null },
        select: { id: true },
      });
      if (existing) {
        return ctx.db.setting.update({ where: { id: existing.id }, data: { value: encoded } });
      }
      return ctx.db.setting.create({
        data: {
          key: input.key,
          value: encoded,
          scope: "project",
          projectId: ctx.projectId,
        },
      });
    }),

  projectReset: projectScopedMutationProcedure
    .input(ProjectResetInput)
    .mutation(async ({ ctx, input }) => {
      const def = getSettingDef(input.key);
      await ctx.db.setting.deleteMany({
        where: { key: input.key, projectId: ctx.projectId, scope: "project" },
      });
      return { ok: true, value: def.default };
    }),

  /**
   * Snapshot of audit-trail size + retention setting. Powers the
   * deployment-hub "Audit retention" panel so the admin can see how many
   * rows are eligible for pruning before flipping the switch.
   */
  auditStatus: protectedProcedure.query(async ({ ctx }) => {
    const retentionDays = await loadGlobalSetting(ctx.db, "audit.retention-days");
    const total = await ctx.db.audit.count();
    let eligible = 0;
    let cutoff: Date | null = null;
    if (retentionDays > 0) {
      cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      eligible = await ctx.db.audit.count({ where: { createdAt: { lt: cutoff } } });
    }
    return {
      retentionDays,
      total,
      eligible,
      cutoff: cutoff ? cutoff.toISOString() : null,
    };
  }),

  /**
   * Drop audit rows older than the configured retention window. No-op when
   * retention is disabled (`audit.retention-days = 0`). Mutating + global,
   * so it only runs in read-write mode.
   */
  auditPrune: mutationProcedure.mutation(async ({ ctx }) => {
    const retentionDays = await loadGlobalSetting(ctx.db, "audit.retention-days");
    if (retentionDays <= 0) {
      return { ok: false, reason: "retention disabled", deleted: 0 };
    }
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const deleted = await pruneAuditOlderThan(ctx.db, cutoff);
    logger.info(
      {
        actorUserId: ctx.userId,
        retentionDays,
        cutoff: cutoff.toISOString(),
        deleted,
      },
      "settings: audit pruned",
    );
    return { ok: true, deleted, cutoff: cutoff.toISOString() };
  }),

  /**
   * Current monthly LLM spend + cap. Exposed read-only so the chat pane
   * (or any future banner surface) can warn/block accordingly.
   */
  budgetStatus: protectedProcedure.query(async ({ ctx }) => {
    return getBudgetStatus(ctx.db);
  }),
});
