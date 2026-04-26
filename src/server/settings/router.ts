/**
 * Settings API (Phase 9).
 *
 * Per-user effective settings keyed off the `Setting` table. Clients call
 * `list` to get every catalog key with its current value (default applied
 * when no row exists), and `update` / `reset` to change/clear one key.
 *
 * The catalog (`./catalog.ts`) is the single source of truth for what keys
 * exist, how they validate, and where they live (user / project / global).
 * The router refuses to touch any key not in the catalog so a typo can't
 * silently land a stray Setting row.
 */

import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  decodeSettingValue,
  encodeSettingValue,
  getSettingDef,
  SETTING_KEYS,
  SETTINGS_CATALOG,
  type SettingKey,
} from "@/server/settings/catalog";
import { protectedProcedure, router } from "@/server/trpc";

const SettingKeyEnum = z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]);

const UpdateInput = z.object({
  key: SettingKeyEnum,
  /// Pre-typed JSON-equivalent value. The router re-validates against the
  /// catalog schema before writing so a malformed payload can't slip in.
  value: z.unknown(),
});

const ResetInput = z.object({ key: SettingKeyEnum });

function userIdOrThrow(ctx: { session: { user: { id?: string } } }): string {
  const userId = ctx.session.user.id;
  if (!userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return userId;
}

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
});
