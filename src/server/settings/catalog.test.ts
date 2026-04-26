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
    expect(decodeSettingValue("ui.theme", "{not json")).toBe("system");
  });

  it("decode falls back to default on schema mismatch", () => {
    expect(decodeSettingValue("ui.theme", JSON.stringify("solarized"))).toBe("system");
  });

  it("decode returns default when raw is null (no row)", () => {
    expect(decodeSettingValue("chat.send-on-enter", null)).toBe(true);
  });

  it("encode rejects values that fail validation", () => {
    expect(() => encodeSettingValue("ui.theme", "solarized" as never)).toThrow();
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
});
