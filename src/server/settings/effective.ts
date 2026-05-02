/**
 * Effective-value lookups across the Setting table.
 *
 * The `settings` router only exposes per-user settings (catalog-scoped to
 * `user`). Global toggles like `app.read-only` are *read* by middleware /
 * services through this helper so they don't have to know how the row is
 * stored.
 *
 * Postgres' unique index treats null columns as unconstrained, which means a
 * compound unique on `(key, userId, projectId)` won't enforce one-row-per-key
 * for global rows (both FKs null). We pick the most-recently-updated row to
 * stay deterministic if a duplicate ever lands; the wizard / admin UI is
 * responsible for not creating duplicates in the first place.
 */

import "server-only";
import { cache } from "react";
import type { db as Db } from "@/server/db";
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
 *
 * Cache key is the full argument list — `db` is the stable Prisma singleton,
 * so identity holds across the request and dedup keys reduce to (key) /
 * (projectId, key) / (userId, key) per scope.
 */
export const loadGlobalSetting = cache(async function loadGlobalSetting<K extends SettingKey>(
  db: typeof Db,
  key: K,
): Promise<SettingValue<K>> {
  const def = getSettingDef(key);
  if (def.scope !== "global") {
    throw new Error(`loadGlobalSetting called for non-global key '${key}'`);
  }
  const row = await db.setting.findFirst({
    where: { key, scope: "global", userId: null, projectId: null },
    orderBy: { updatedAt: "desc" },
    select: { value: true },
  });
  return decodeSettingValue(key, row?.value ?? null);
});

export const loadProjectSetting = cache(async function loadProjectSetting<K extends SettingKey>(
  db: typeof Db,
  projectId: string,
  key: K,
): Promise<SettingValue<K>> {
  const def = getSettingDef(key);
  if (def.scope !== "project") {
    throw new Error(`loadProjectSetting called for non-project key '${key}'`);
  }
  const row = await db.setting.findFirst({
    where: { key, scope: "project", projectId, userId: null },
    orderBy: { updatedAt: "desc" },
    select: { value: true },
  });
  return decodeSettingValue(key, row?.value ?? null);
});

export const loadUserSetting = cache(async function loadUserSetting<K extends SettingKey>(
  db: typeof Db,
  userId: string,
  key: K,
): Promise<SettingValue<K>> {
  const def = getSettingDef(key);
  if (def.scope !== "user") {
    throw new Error(`loadUserSetting called for non-user key '${key}'`);
  }
  const row = await db.setting.findFirst({
    where: { key, scope: "user", userId, projectId: null },
    orderBy: { updatedAt: "desc" },
    select: { value: true },
  });
  return decodeSettingValue(key, row?.value ?? null);
});

// Postgres treats NULL columns as unconstrained in compound uniques, so a
// global / per-user / per-project Setting (the "other" FKs are NULL) needs
// find-then-update/create rather than a Prisma upsert. Helpers below
// encapsulate that pattern; the catalog's `encodeSettingValue` re-validates
// the value against the catalog schema so a buggy caller can't write junk.

export async function upsertGlobalSetting<K extends SettingKey>(
  db: typeof Db,
  key: K,
  value: SettingValue<K>,
): Promise<void> {
  const def = getSettingDef(key);
  if (def.scope !== "global") {
    throw new Error(`upsertGlobalSetting called for non-global key '${key}'`);
  }
  const encoded = encodeSettingValue(key, value);
  const existing = await db.setting.findFirst({
    where: { key, scope: "global", userId: null, projectId: null },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (existing) {
    await db.setting.update({ where: { id: existing.id }, data: { value: encoded } });
    return;
  }
  await db.setting.create({ data: { key, value: encoded, scope: "global" } });
}

export async function upsertProjectSetting<K extends SettingKey>(
  db: typeof Db,
  projectId: string,
  key: K,
  value: SettingValue<K>,
): Promise<void> {
  const def = getSettingDef(key);
  if (def.scope !== "project") {
    throw new Error(`upsertProjectSetting called for non-project key '${key}'`);
  }
  const encoded = encodeSettingValue(key, value);
  const existing = await db.setting.findFirst({
    where: { key, scope: "project", projectId, userId: null },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (existing) {
    await db.setting.update({ where: { id: existing.id }, data: { value: encoded } });
    return;
  }
  await db.setting.create({ data: { key, value: encoded, scope: "project", projectId } });
}

export async function upsertUserSetting<K extends SettingKey>(
  db: typeof Db,
  userId: string,
  key: K,
  value: SettingValue<K>,
): Promise<void> {
  const def = getSettingDef(key);
  if (def.scope !== "user") {
    throw new Error(`upsertUserSetting called for non-user key '${key}'`);
  }
  const encoded = encodeSettingValue(key, value);
  const existing = await db.setting.findFirst({
    where: { key, scope: "user", userId, projectId: null },
    select: { id: true },
  });
  if (existing) {
    await db.setting.update({ where: { id: existing.id }, data: { value: encoded } });
    return;
  }
  await db.setting.create({ data: { key, value: encoded, scope: "user", userId } });
}
