// Wire format: `enc:v1:<base64-iv>:<base64-ciphertext-and-tag>`. The `v1`
// tag lets us migrate to a different cipher / key length later without
// ambiguity. SECRETS_KEY is required; both dev (`bin/generate-secrets.sh`)
// and Docker (`bin/docker-entrypoint.sh`) seed one before boot.

import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;
let cacheChecked = false;

function loadKey(): Buffer | null {
  if (cacheChecked) return cachedKey;
  cacheChecked = true;
  const raw = process.env["SECRETS_KEY"]?.trim();
  if (!raw) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    throw new Error("SECRETS_KEY must be valid base64");
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(`SECRETS_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length})`);
  }
  cachedKey = buf;
  return buf;
}

function requireKey(): Buffer {
  const key = loadKey();
  if (!key) {
    throw new Error("SECRETS_KEY is required (32 random bytes, base64)");
  }
  return key;
}

export function isEncryptionConfigured(): boolean {
  return loadKey() !== null;
}

export function assertEncryptionConfigured(context: string): void {
  if (loadKey() === null) {
    throw new Error(
      `${context} requires SECRETS_KEY to be set (32 random bytes, base64) — refusing to store secrets in plaintext`,
    );
  }
}

/** Test-only: drop the cached key so a flipped env var takes effect. */
export function _resetEncryptionCacheForTests(): void {
  cachedKey = null;
  cacheChecked = false;
}

export function encryptSecret(plaintext: string): string {
  if (plaintext.length === 0) return plaintext;
  // Guard against accidental double-encryption when a write path wraps twice.
  if (plaintext.startsWith(PREFIX)) return plaintext;
  const key = requireKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new Error(`AES-GCM auth tag length mismatch (expected ${TAG_BYTES}, got ${tag.length})`);
  }
  const payload = Buffer.concat([ciphertext, tag]).toString("base64");
  return `${PREFIX}${iv.toString("base64")}:${payload}`;
}

export function decryptSecret(stored: string): string {
  if (stored.length === 0) return stored;
  if (!stored.startsWith(PREFIX)) {
    throw new Error("decryptSecret: stored value is not encrypted (missing enc:v1: prefix)");
  }
  const key = requireKey();
  const rest = stored.slice(PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep < 0) {
    throw new Error("decryptSecret: malformed payload (missing iv separator)");
  }
  const iv = Buffer.from(rest.slice(0, sep), "base64");
  if (iv.length !== IV_BYTES) {
    throw new Error(`decryptSecret: iv length mismatch (expected ${IV_BYTES}, got ${iv.length})`);
  }
  const blob = Buffer.from(rest.slice(sep + 1), "base64");
  if (blob.length <= TAG_BYTES) {
    throw new Error("decryptSecret: ciphertext shorter than auth tag");
  }
  const ciphertext = blob.subarray(0, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
