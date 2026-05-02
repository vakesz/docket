/**
 * Effective-value lookups across the Setting table.
 *
 * The `settings` router only exposes per-user settings (catalog-scoped to
 * `user`). Global toggles like `app.read-only` are *read* by middleware /
 * services through this helper so they don't have to know how the row is
 * stored.
 *
 * Three partial unique indexes (declared on `settings` itself) enforce one
 * row per (key, scope) per partition. Writes use Drizzle's
 * `onConflictDoUpdate` against the matching partial-unique index so the
 * upsert is a single round-trip with no find-then-update race.
 */

import "server-only";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { cache } from "react";
import type { ProjectId, UserId } from "@/core/types";
import type { Db } from "@/db";
import { settings } from "@/db/schema";
import {
  decodeSettingValue,
  encodeSettingValue,
  getSettingDef,
  type SettingKey,
  type SettingValue,
} from "@/server/settings/catalog";

/**
 * Wrapped in `React.cache` so multiple server components (page + layout +
 * children) reading the same setting in one render pass share a single DB
 * round-trip. Outside an RSC render the wrapper is effectively a passthrough,
 * so tRPC / API-route call sites pay no penalty.
 */
export const loadGlobalSetting = cache(async function loadGlobalSetting<K extends SettingKey>(
  db: Db,
  key: K,
): Promise<SettingValue<K>> {
  const def = getSettingDef(key);
  if (def.scope !== "global") {
    throw new Error(`loadGlobalSetting called for non-global key '${key}'`);
  }
  const row = await db.query.settings.findFirst({
    where: and(
      eq(settings.key, key),
      eq(settings.scope, "global"),
      isNull(settings.userId),
      isNull(settings.projectId),
    ),
    orderBy: [desc(settings.updatedAt)],
    columns: { value: true },
  });
  return decodeSettingValue(key, row?.value ?? null);
});

export const loadProjectSetting = cache(async function loadProjectSetting<K extends SettingKey>(
  db: Db,
  projectId: ProjectId,
  key: K,
): Promise<SettingValue<K>> {
  const def = getSettingDef(key);
  if (def.scope !== "project") {
    throw new Error(`loadProjectSetting called for non-project key '${key}'`);
  }
  const row = await db.query.settings.findFirst({
    where: and(
      eq(settings.key, key),
      eq(settings.scope, "project"),
      eq(settings.projectId, projectId),
      isNull(settings.userId),
    ),
    orderBy: [desc(settings.updatedAt)],
    columns: { value: true },
  });
  return decodeSettingValue(key, row?.value ?? null);
});

export const loadUserSetting = cache(async function loadUserSetting<K extends SettingKey>(
  db: Db,
  userId: UserId,
  key: K,
): Promise<SettingValue<K>> {
  const def = getSettingDef(key);
  if (def.scope !== "user") {
    throw new Error(`loadUserSetting called for non-user key '${key}'`);
  }
  const row = await db.query.settings.findFirst({
    where: and(
      eq(settings.key, key),
      eq(settings.scope, "user"),
      eq(settings.userId, userId),
      isNull(settings.projectId),
    ),
    orderBy: [desc(settings.updatedAt)],
    columns: { value: true },
  });
  return decodeSettingValue(key, row?.value ?? null);
});

// Each upsert targets the matching partial-unique index. Because the
// partial-unique `where` predicates use `IS NULL` / `IS NOT NULL`, the
// conflict target column list must match the index declaration exactly:
// global → (key) where user/project NULL; user → (key, userId) where
// projectId NULL; project → (key, projectId) where userId NULL.

export async function upsertGlobalSetting<K extends SettingKey>(
  db: Db,
  key: K,
  value: SettingValue<K>,
): Promise<void> {
  const def = getSettingDef(key);
  if (def.scope !== "global") {
    throw new Error(`upsertGlobalSetting called for non-global key '${key}'`);
  }
  const encoded = encodeSettingValue(key, value);
  await db
    .insert(settings)
    .values({ key, value: encoded, scope: "global", userId: null, projectId: null })
    .onConflictDoUpdate({
      target: [settings.key],
      targetWhere: sql`${settings.userId} IS NULL AND ${settings.projectId} IS NULL`,
      set: { value: encoded, updatedAt: new Date() },
    });
}

export async function upsertProjectSetting<K extends SettingKey>(
  db: Db,
  projectId: ProjectId,
  key: K,
  value: SettingValue<K>,
): Promise<void> {
  const def = getSettingDef(key);
  if (def.scope !== "project") {
    throw new Error(`upsertProjectSetting called for non-project key '${key}'`);
  }
  const encoded = encodeSettingValue(key, value);
  await db
    .insert(settings)
    .values({ key, value: encoded, scope: "project", projectId, userId: null })
    .onConflictDoUpdate({
      target: [settings.key, settings.projectId],
      targetWhere: sql`${settings.userId} IS NULL AND ${settings.projectId} IS NOT NULL`,
      set: { value: encoded, updatedAt: new Date() },
    });
}

export async function upsertUserSetting<K extends SettingKey>(
  db: Db,
  userId: UserId,
  key: K,
  value: SettingValue<K>,
): Promise<void> {
  const def = getSettingDef(key);
  if (def.scope !== "user") {
    throw new Error(`upsertUserSetting called for non-user key '${key}'`);
  }
  const encoded = encodeSettingValue(key, value);
  await db
    .insert(settings)
    .values({ key, value: encoded, scope: "user", userId, projectId: null })
    .onConflictDoUpdate({
      target: [settings.key, settings.userId],
      targetWhere: sql`${settings.userId} IS NOT NULL AND ${settings.projectId} IS NULL`,
      set: { value: encoded, updatedAt: new Date() },
    });
}
