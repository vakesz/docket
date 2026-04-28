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
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getBudgetStatus } from "@/server/billing/budget";
import { pruneAuditOlderThan } from "@/server/proposals/executor";
import {
  decodeSettingValue,
  encodeSettingValue,
  getSettingDef,
  SETTING_KEYS,
  SETTINGS_CATALOG,
  type SettingKey,
} from "@/server/settings/catalog";
import { loadGlobalSetting } from "@/server/settings/effective";
import {
  mutationProcedure,
  projectIdSchema,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  protectedProcedure,
  router,
  userIdOrThrow,
} from "@/server/trpc";

const SettingKeyEnum = z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]);

const UpdateInput = z.object({
  key: SettingKeyEnum,
  /// Pre-typed JSON-equivalent value. The router re-validates against the
  /// catalog schema before writing so a malformed payload can't slip in.
  value: z.unknown(),
});

const ResetInput = z.object({ key: SettingKeyEnum });

const ProjectUpdateInput = projectIdSchema.extend({
  key: SettingKeyEnum,
  value: z.unknown(),
});

const ProjectResetInput = projectIdSchema.extend({
  key: SettingKeyEnum,
});

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
    const userId = userIdOrThrow(ctx);
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

  update: protectedProcedure.input(UpdateInput).mutation(async ({ ctx, input }) => {
    const userId = userIdOrThrow(ctx);
    const def = getSettingDef(input.key);
    if (def.scope !== "user") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `setting '${input.key}' is ${def.scope}-scoped — use the matching surface`,
      });
    }
    let encoded: string;
    try {
      encoded = encodeSettingValue(input.key, input.value as never);
    } catch (err) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `value for '${input.key}' failed validation: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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

  reset: protectedProcedure.input(ResetInput).mutation(async ({ ctx, input }) => {
    const userId = userIdOrThrow(ctx);
    const def = getSettingDef(input.key);
    if (def.scope !== "user") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `setting '${input.key}' is ${def.scope}-scoped — use the matching surface`,
      });
    }
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

  globalUpdate: mutationProcedure.input(UpdateInput).mutation(async ({ ctx, input }) => {
    const def = getSettingDef(input.key);
    if (def.scope !== "global") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `setting '${input.key}' is ${def.scope}-scoped — use the matching surface`,
      });
    }
    if (input.key === "setup.complete") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "setup.complete is managed by the bootstrap flow",
      });
    }
    let encoded: string;
    try {
      encoded = encodeSettingValue(input.key, input.value as never);
    } catch (err) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `value for '${input.key}' failed validation: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const existing = await ctx.db.setting.findFirst({
      where: { key: input.key, scope: "global", userId: null, projectId: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (existing) {
      return ctx.db.setting.update({ where: { id: existing.id }, data: { value: encoded } });
    }
    return ctx.db.setting.create({ data: { key: input.key, value: encoded, scope: "global" } });
  }),

  globalReset: mutationProcedure.input(ResetInput).mutation(async ({ ctx, input }) => {
    const def = getSettingDef(input.key);
    if (def.scope !== "global") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `setting '${input.key}' is ${def.scope}-scoped — use the matching surface`,
      });
    }
    if (input.key === "setup.complete") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "setup.complete is managed by the bootstrap flow",
      });
    }
    await ctx.db.setting.deleteMany({
      where: { key: input.key, scope: "global", userId: null, projectId: null },
    });
    return { ok: true, value: def.default };
  }),

  /**
   * Effective project-scoped settings for the requested project. Returns
   * every project-scoped catalog key (catalog default substituted when the
   * row is missing or invalid).
   */
  projectList: projectScopedProcedure.input(projectIdSchema).query(async ({ ctx, input }) => {
    const projectKeys = SETTING_KEYS.filter((k) => SETTINGS_CATALOG[k].scope === "project");
    const rows = await ctx.db.setting.findMany({
      where: {
        projectId: input.projectId,
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
      const def = getSettingDef(input.key);
      if (def.scope !== "project") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `setting '${input.key}' is ${def.scope}-scoped — use the matching surface`,
        });
      }
      let encoded: string;
      try {
        encoded = encodeSettingValue(input.key, input.value as never);
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `value for '${input.key}' failed validation: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      const existing = await ctx.db.setting.findFirst({
        where: { key: input.key, projectId: input.projectId, scope: "project", userId: null },
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
          projectId: input.projectId,
        },
      });
    }),

  projectReset: projectScopedMutationProcedure
    .input(ProjectResetInput)
    .mutation(async ({ ctx, input }) => {
      const def = getSettingDef(input.key);
      if (def.scope !== "project") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `setting '${input.key}' is ${def.scope}-scoped — use the matching surface`,
        });
      }
      await ctx.db.setting.deleteMany({
        where: { key: input.key, projectId: input.projectId, scope: "project" },
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
