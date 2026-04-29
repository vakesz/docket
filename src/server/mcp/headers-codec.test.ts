import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetEncryptionCacheForTests } from "@/server/secrets/encryption";
import { decodeHeaders, encodeHeaders } from "./headers-codec";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("mcp headers-codec", () => {
  beforeEach(() => {
    process.env.SECRETS_KEY = KEY;
    _resetEncryptionCacheForTests();
  });
  afterEach(() => {
    delete process.env.SECRETS_KEY;
    _resetEncryptionCacheForTests();
  });

  it("round-trips a non-empty headers map encrypted", () => {
    const plain = { Authorization: "Bearer abc", "X-Org": "acme" };
    const encoded = encodeHeaders(plain);
    expect(typeof encoded).toBe("object");
    const stringified = JSON.stringify(encoded);
    expect(stringified).not.toContain("Bearer abc");
    expect(stringified).toContain("enc:v1:");
    expect(decodeHeaders(encoded)).toEqual(plain);
  });

  it("encodes empty as plain {}", () => {
    expect(encodeHeaders({})).toEqual({});
    expect(decodeHeaders({})).toEqual({});
  });

  it("decodes legacy plaintext object as-is", () => {
    expect(decodeHeaders({ Authorization: "Bearer raw" })).toEqual({
      Authorization: "Bearer raw",
    });
  });

  it("filters non-string legacy values", () => {
    expect(decodeHeaders({ Authorization: "Bearer raw", count: 3 })).toEqual({
      Authorization: "Bearer raw",
    });
  });

  it("returns {} for null / undefined / array", () => {
    expect(decodeHeaders(null)).toEqual({});
    expect(decodeHeaders(undefined)).toEqual({});
    expect(decodeHeaders([])).toEqual({});
  });
});
