import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetEncryptionCacheForTests,
  assertEncryptionConfigured,
  decryptSecret,
  encryptSecret,
  isEncryptionConfigured,
} from "@/server/secrets/encryption";

const ORIGINAL_KEY = process.env["SECRETS_KEY"];

function setKey(key: string | undefined): void {
  if (key === undefined) delete process.env["SECRETS_KEY"];
  else process.env["SECRETS_KEY"] = key;
  _resetEncryptionCacheForTests();
}

function freshKey(): string {
  return randomBytes(32).toString("base64");
}

beforeEach(() => {
  setKey(undefined);
});

afterEach(() => {
  setKey(ORIGINAL_KEY);
});

describe("secrets encryption", () => {
  it("round-trips an encrypted secret with a configured key", () => {
    setKey(freshKey());
    const enc = encryptSecret("sk_live_supersecret");
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(enc)).toBe("sk_live_supersecret");
  });

  it("throws when SECRETS_KEY is unset on encrypt", () => {
    expect(() => encryptSecret("plain-token")).toThrow(/SECRETS_KEY is required/);
  });

  it("rejects unencrypted strings on decrypt", () => {
    setKey(freshKey());
    expect(() => decryptSecret("plain-token")).toThrow(/not encrypted/);
  });

  it("never double-encrypts an already-encrypted payload", () => {
    setKey(freshKey());
    const once = encryptSecret("hello");
    const twice = encryptSecret(once);
    expect(twice).toBe(once);
    expect(decryptSecret(twice)).toBe("hello");
  });

  it("throws when SECRETS_KEY is unset on read", () => {
    setKey(freshKey());
    const enc = encryptSecret("token");
    setKey(undefined);
    expect(() => decryptSecret(enc)).toThrow(/SECRETS_KEY is required/);
  });

  it("rejects malformed encrypted payloads", () => {
    setKey(freshKey());
    expect(() => decryptSecret("enc:v1:not-base64")).toThrow();
    expect(() => decryptSecret("enc:v1:abc:abc")).toThrow();
  });

  it("each encryption uses a fresh IV (ciphertexts differ)", () => {
    setKey(freshKey());
    const a = encryptSecret("same plaintext");
    const b = encryptSecret("same plaintext");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same plaintext");
    expect(decryptSecret(b)).toBe("same plaintext");
  });

  it("rejects keys that aren't 32 bytes after base64 decode", () => {
    setKey(Buffer.from("too short").toString("base64"));
    expect(() => encryptSecret("hello")).toThrow(/32 bytes/);
  });

  it("isEncryptionConfigured reports key presence", () => {
    expect(isEncryptionConfigured()).toBe(false);
    setKey(freshKey());
    expect(isEncryptionConfigured()).toBe(true);
  });

  it("assertEncryptionConfigured throws with a context label when unset", () => {
    expect(() => assertEncryptionConfigured("settings/llm-providers")).toThrow(
      /settings\/llm-providers.*SECRETS_KEY/,
    );
    setKey(freshKey());
    expect(() => assertEncryptionConfigured("settings/llm-providers")).not.toThrow();
  });

  it("empty plaintext stays empty (avoids storing a useless payload)", () => {
    setKey(freshKey());
    expect(encryptSecret("")).toBe("");
    expect(decryptSecret("")).toBe("");
  });
});
