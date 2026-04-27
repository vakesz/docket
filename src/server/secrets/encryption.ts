/**
 * AES-GCM at-rest encryption for provider credentials.
 *
 * The DB stores stuff that's only as private as the row it lives in
 * (`OauthProviderConfig.clientSecret`, `LlmProvider.apiKey`). A leaked
 * `pg_dump` shouldn't be a leaked OpenAI key — so the values get wrapped
 * with `SECRETS_KEY` (32 bytes, base64) before they hit the column.
 *
 * Wire format (one column = one string):
 *
 *     enc:v1:<base64-iv>:<base64-ciphertext-and-tag>
 *
 * The version tag (`v1`) lets us migrate to a different cipher / key length
 * later without ambiguity. Anything that doesn't start with the prefix is
 * treated as legacy plaintext — `decryptSecret` returns it as-is, so dev
 * setups without `SECRETS_KEY` keep working.
 *
 * `SECRETS_KEY` policy:
 *   - **Prod**: required. `assertEncryptionConfigured` throws on boot if
 *     missing.
 *   - **Dev**: optional. Without it, writes pass through and reads accept
 *     plaintext — but the moment the operator sets the key, new writes are
 *     encrypted; old plaintext rows still decrypt as plaintext until they
 *     are touched. A future re-encrypt script can bulk-upgrade legacy rows.
 */

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
  const raw = process.env.SECRETS_KEY?.trim();
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

/** True when `SECRETS_KEY` is set and valid. */
export function isEncryptionConfigured(): boolean {
  return loadKey() !== null;
}

/**
 * Throw if encryption is not configured. Use at boot in prod paths so a
 * silent plaintext fallback doesn't ship to production.
 */
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

/**
 * Encrypt a plaintext secret for at-rest storage. When `SECRETS_KEY` is
 * unset, returns the plaintext unchanged so dev setups work — but emits
 * a one-line warning so the operator notices.
 */
export function encryptSecret(plaintext: string): string {
  if (plaintext.length === 0) return plaintext;
  if (plaintext.startsWith(PREFIX)) {
    // Already encrypted — guard against accidental double-encryption when
    // a write path is wrapped twice.
    return plaintext;
  }
  const key = loadKey();
  if (!key) {
    if (!_warnedPlaintext) {
      console.warn(
        "secrets.encryptSecret: SECRETS_KEY unset — storing secret in plaintext (dev only)",
      );
      _warnedPlaintext = true;
    }
    return plaintext;
  }
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

/**
 * Decrypt a stored secret. Accepts both encrypted (`enc:v1:...`) and
 * legacy plaintext payloads — legacy returns as-is, so reads keep working
 * across a key rollout.
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const key = loadKey();
  if (!key) {
    throw new Error("decryptSecret: stored value is encrypted but SECRETS_KEY is unset");
  }
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

/** True when `stored` is an `enc:v1:` payload (vs. legacy plaintext). */
export function isEncryptedPayload(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

let _warnedPlaintext = false;
