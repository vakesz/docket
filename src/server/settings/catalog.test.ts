import { describe, expect, it } from "vitest";
import {
  decodeSettingValue,
  encodeSettingValue,
  getSettingDef,
  SETTING_KEYS,
  SETTINGS_CATALOG,
} from "@/server/settings/catalog";

describe("settings catalog", () => {
  it("every catalog entry's default validates against its own schema", () => {
    for (const key of SETTING_KEYS) {
      const def = SETTINGS_CATALOG[key];
      expect(() => def.schema.parse(def.default), `default for ${key}`).not.toThrow();
    }
  });

  it("every catalog entry round-trips encode/decode", () => {
    for (const key of SETTING_KEYS) {
      const def = SETTINGS_CATALOG[key];
      const encoded = encodeSettingValue(key, def.default);
      const decoded = decodeSettingValue(key, encoded);
      expect(decoded).toEqual(def.default);
    }
  });

  it("decode falls back to default on bad JSON", () => {
    expect(decodeSettingValue("chat.send-on-enter", "{not json")).toBe(true);
  });

  it("decode falls back to default on schema mismatch", () => {
    expect(decodeSettingValue("chat.send-on-enter", JSON.stringify("nope"))).toBe(true);
  });

  it("decode returns default when raw is null (no row)", () => {
    expect(decodeSettingValue("chat.send-on-enter", null)).toBe(true);
  });

  it("encode rejects values that fail validation", () => {
    expect(() => encodeSettingValue("chat.send-on-enter", "yes" as never)).toThrow();
  });

  it("getSettingDef throws on unknown keys", () => {
    expect(() => getSettingDef("nope")).toThrow(/unknown setting key/);
  });

  it("app.read-only is global-scoped and defaults to false", () => {
    const def = getSettingDef("app.read-only");
    expect(def.scope).toBe("global");
    expect(def.default).toBe(false);
    expect(decodeSettingValue("app.read-only", null)).toBe(false);
    expect(decodeSettingValue("app.read-only", JSON.stringify(true))).toBe(true);
  });

  it("setup.complete is global-scoped and defaults to false", () => {
    const def = getSettingDef("setup.complete");
    expect(def.scope).toBe("global");
    expect(def.default).toBe(false);
    expect(decodeSettingValue("setup.complete", null)).toBe(false);
    expect(decodeSettingValue("setup.complete", JSON.stringify(true))).toBe(true);
  });

  it("items.stale-after-days is project-scoped and accepts non-negative ints", () => {
    const def = getSettingDef("items.stale-after-days");
    expect(def.scope).toBe("project");
    expect(decodeSettingValue("items.stale-after-days", null)).toBe(7);
    expect(decodeSettingValue("items.stale-after-days", JSON.stringify(0))).toBe(0);
    expect(decodeSettingValue("items.stale-after-days", JSON.stringify(30))).toBe(30);
    expect(decodeSettingValue("items.stale-after-days", JSON.stringify(-1))).toBe(7);
    expect(decodeSettingValue("items.stale-after-days", JSON.stringify(1.5))).toBe(7);
  });

  it("items.stale-after-days.user is user-scoped with -1 sentinel", () => {
    const def = getSettingDef("items.stale-after-days.user");
    expect(def.scope).toBe("user");
    expect(def.default).toBe(-1);
    expect(decodeSettingValue("items.stale-after-days.user", null)).toBe(-1);
    expect(decodeSettingValue("items.stale-after-days.user", JSON.stringify(-1))).toBe(-1);
    expect(decodeSettingValue("items.stale-after-days.user", JSON.stringify(0))).toBe(0);
    expect(decodeSettingValue("items.stale-after-days.user", JSON.stringify(14))).toBe(14);
    // values below -1 fall back to default
    expect(decodeSettingValue("items.stale-after-days.user", JSON.stringify(-5))).toBe(-1);
    expect(decodeSettingValue("items.stale-after-days.user", JSON.stringify(2.5))).toBe(-1);
  });
});
