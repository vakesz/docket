/**
 * Typed settings catalog — the source of truth for what keys exist, how
 * their values validate, and where they live (user / project / global).
 *
 * Adding a setting is one entry here plus (usually) one form field on the
 * settings page. The router validates every update against the catalog,
 * defaults are applied at read time, and the on-disk encoding is
 * `JSON.stringify(value)` so the `Setting.value` column stays a single
 * string regardless of the value's shape.
 *
 * Server-only deliberately: the catalog imports server-only helpers so the
 * tRPC layer can use it directly. The Zod schemas it exposes are isomorphic
 * across client/server, but the catalog object itself is not — clients see
 * the inferred TS types via the tRPC router.
 */

import "server-only";
import { z } from "zod";

export const SETTING_SCOPES = ["user", "project", "global"] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

export type SettingDef<S extends z.ZodTypeAny> = {
  key: string;
  scope: SettingScope;
  schema: S;
  default: z.infer<S>;
  /** Human-readable label shown on the settings page. */
  label: string;
  /** One-line description shown under the field. */
  description: string;
};

const BoolSchema = z.boolean();
const PositiveIntSchema = z.number().int().min(0).max(3650);

// Theme is intentionally browser-local (see `src/lib/theme.ts` +
// ThemePicker in the top bar) — same pattern main uses. Keeping it out
// of the catalog avoids a split-brain where the DB row says "light" while
// the user's browser is on "rose-pine-moon".
export const SETTINGS_CATALOG = {
  "chat.send-on-enter": {
    key: "chat.send-on-enter",
    scope: "user",
    schema: BoolSchema,
    default: true,
    label: "Send chat on Enter",
    description:
      "When on, Enter sends the message and Shift-Enter inserts a newline. When off, the keys swap.",
  },
  "app.read-only": {
    key: "app.read-only",
    scope: "global",
    schema: BoolSchema,
    default: false,
    label: "System read-only mode",
    description:
      "When on, every mutation route — including proposal confirms — is blocked. Reads stay open. Flip on for maintenance windows.",
  },
  "setup.complete": {
    key: "setup.complete",
    scope: "global",
    schema: BoolSchema,
    default: false,
    label: "Initial setup complete",
    description:
      "Sticky bit flipped on the first request that observes at least one LLM provider and at least one OAuth provider. Middleware uses it to decide whether to redirect to /admin/setup. Manually toggle off only when reverting after a destructive admin operation.",
  },
  "items.stale-after-days": {
    key: "items.stale-after-days",
    scope: "global",
    schema: PositiveIntSchema,
    default: 7,
    label: "Stale-after threshold (days)",
    description:
      "Backlog rows tint amber once an item has been untouched this long, and red at 2x. Set to 0 to disable the freshness tint entirely.",
  },
} as const satisfies Record<string, SettingDef<z.ZodTypeAny>>;

export type SettingKey = keyof typeof SETTINGS_CATALOG;
export const SETTING_KEYS = Object.keys(SETTINGS_CATALOG) as SettingKey[];

export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS_CATALOG)[K]["schema"]>;

/**
 * Resolve the catalog entry for a key, throwing on unknown keys. The router
 * uses this everywhere it touches the catalog so the unknown-key error is
 * one shape, not three.
 */
export function getSettingDef<K extends SettingKey>(key: K): (typeof SETTINGS_CATALOG)[K];
export function getSettingDef(key: string): SettingDef<z.ZodTypeAny>;
export function getSettingDef(key: string): SettingDef<z.ZodTypeAny> {
  const def = (SETTINGS_CATALOG as Record<string, SettingDef<z.ZodTypeAny>>)[key];
  if (!def) {
    throw new Error(`unknown setting key: '${key}'`);
  }
  return def;
}

/**
 * Decode a stored `Setting.value` string into the typed value, or return
 * the catalog default when the row's value fails to decode/validate. Bad
 * rows shouldn't take down the settings page; they get logged and the
 * default surfaces instead.
 */
export function decodeSettingValue<K extends SettingKey>(
  key: K,
  raw: string | null,
): SettingValue<K> {
  const def = getSettingDef(key);
  if (raw === null) return def.default as SettingValue<K>;
  try {
    const parsed = JSON.parse(raw);
    return def.schema.parse(parsed) as SettingValue<K>;
  } catch {
    return def.default as SettingValue<K>;
  }
}

export function encodeSettingValue<K extends SettingKey>(key: K, value: SettingValue<K>): string {
  const def = getSettingDef(key);
  // Re-validate so the on-wire representation matches the catalog.
  const validated = def.schema.parse(value);
  return JSON.stringify(validated);
}
