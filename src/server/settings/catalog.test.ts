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

  it("display.timezone accepts empty + valid IANA names, rejects garbage", () => {
    const def = getSettingDef("display.timezone");
    expect(def.scope).toBe("user");
    expect(def.default).toBe("");
    expect(decodeSettingValue("display.timezone", null)).toBe("");
    expect(decodeSettingValue("display.timezone", JSON.stringify(""))).toBe("");
    expect(decodeSettingValue("display.timezone", JSON.stringify("Europe/Stockholm"))).toBe(
      "Europe/Stockholm",
    );
    expect(decodeSettingValue("display.timezone", JSON.stringify("UTC"))).toBe("UTC");
    // Garbage falls back to the default rather than blowing up the page.
    expect(decodeSettingValue("display.timezone", JSON.stringify("Mars/Olympus"))).toBe("");
    // Encode rejects invalid zones at the catalog boundary.
    expect(() => encodeSettingValue("display.timezone", "Mars/Olympus")).toThrow();
  });

  it("items.show-reactions-header and -comments default true and round-trip", () => {
    for (const key of ["items.show-reactions-header", "items.show-reactions-comments"] as const) {
      const def = getSettingDef(key);
      expect(def.scope).toBe("user");
      expect(def.default).toBe(true);
      expect(decodeSettingValue(key, null)).toBe(true);
      expect(decodeSettingValue(key, JSON.stringify(false))).toBe(false);
      expect(decodeSettingValue(key, JSON.stringify(true))).toBe(true);
    }
  });

  it("recommendation boolean toggles default on, project-scoped, and round-trip", () => {
    for (const key of [
      "recommendations.likely-resolved.enabled",
      "recommendations.duplicate-detection.enabled",
      "recommendations.code-examples.enabled",
    ] as const) {
      const def = getSettingDef(key);
      expect(def.scope).toBe("project");
      expect(def.default).toBe(true);
      expect(decodeSettingValue(key, null)).toBe(true);
      expect(decodeSettingValue(key, JSON.stringify(false))).toBe(false);
      // Non-boolean values fall back to the default rather than blowing up.
      expect(decodeSettingValue(key, JSON.stringify("yes"))).toBe(true);
    }
  });

  it("recommendations.code-examples.max-lines accepts 1..40 and rejects 0 / >40", () => {
    const key = "recommendations.code-examples.max-lines";
    expect(getSettingDef(key).scope).toBe("project");
    expect(decodeSettingValue(key, null)).toBe(20);
    expect(decodeSettingValue(key, JSON.stringify(1))).toBe(1);
    expect(decodeSettingValue(key, JSON.stringify(40))).toBe(40);
    // Out-of-range falls back to the default.
    expect(decodeSettingValue(key, JSON.stringify(0))).toBe(20);
    expect(decodeSettingValue(key, JSON.stringify(41))).toBe(20);
    expect(decodeSettingValue(key, JSON.stringify(2.5))).toBe(20);
    expect(() => encodeSettingValue(key, 0 as never)).toThrow();
    expect(() => encodeSettingValue(key, 41 as never)).toThrow();
  });

  it("recommendations.code-examples.max-snippets-per-reply accepts 0..4", () => {
    const key = "recommendations.code-examples.max-snippets-per-reply";
    expect(getSettingDef(key).scope).toBe("project");
    expect(decodeSettingValue(key, null)).toBe(2);
    expect(decodeSettingValue(key, JSON.stringify(0))).toBe(0);
    expect(decodeSettingValue(key, JSON.stringify(4))).toBe(4);
    expect(decodeSettingValue(key, JSON.stringify(5))).toBe(2);
    expect(decodeSettingValue(key, JSON.stringify(-1))).toBe(2);
    expect(() => encodeSettingValue(key, -1 as never)).toThrow();
    expect(() => encodeSettingValue(key, 5 as never)).toThrow();
  });

  it("recommendations.duplicate-detection.similarity-threshold accepts 50..95", () => {
    const key = "recommendations.duplicate-detection.similarity-threshold";
    expect(getSettingDef(key).scope).toBe("project");
    expect(decodeSettingValue(key, null)).toBe(70);
    expect(decodeSettingValue(key, JSON.stringify(50))).toBe(50);
    expect(decodeSettingValue(key, JSON.stringify(95))).toBe(95);
    expect(decodeSettingValue(key, JSON.stringify(49))).toBe(70);
    expect(decodeSettingValue(key, JSON.stringify(96))).toBe(70);
    expect(() => encodeSettingValue(key, 49 as never)).toThrow();
    expect(() => encodeSettingValue(key, 96 as never)).toThrow();
  });
});
