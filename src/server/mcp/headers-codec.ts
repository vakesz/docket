/**
 * Encrypt MCP server headers at rest.
 *
 * `McpServerConfig.headersJson` carries auth tokens (PATs, OAuth bearer
 * tokens). The whole headers object is serialized to JSON, encrypted via
 * `enc:v1:` from `secrets/encryption.ts`, and stored under a single
 * `_enc` key so Prisma's `Json` typing stays untouched. An empty headers
 * object is stored as `{}` (no point spending an IV on nothing). Legacy
 * plaintext rows (from before encryption was wired) decode unchanged on
 * read; the next write upgrades them.
 */

import "server-only";
import type { Prisma } from "@/db/generated/client";
import { decryptSecret, encryptSecret } from "@/server/secrets/encryption";

const ENC_KEY = "_enc";

/** Encode a plaintext headers map for storage. Empty stays empty. */
export function encodeHeaders(plain: Record<string, string>): Prisma.InputJsonValue {
  const keys = Object.keys(plain);
  if (keys.length === 0) return {} satisfies Record<string, never>;
  const blob = encryptSecret(JSON.stringify(plain));
  return { [ENC_KEY]: blob };
}

/**
 * Decode a stored headers value. Accepts three shapes:
 *   - `{ _enc: "enc:v1:..." }` — encrypted (current write format)
 *   - `{ key: value, ... }`    — legacy plaintext
 *   - `{}` / null / undefined  — empty
 */
export function decodeHeaders(stored: unknown): Record<string, string> {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const obj = stored as Record<string, unknown>;
  const enc = obj[ENC_KEY];
  if (typeof enc === "string") {
    try {
      const plaintext = decryptSecret(enc);
      const parsed = JSON.parse(plaintext);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.values(parsed).every((v) => typeof v === "string")
      ) {
        return parsed as Record<string, string>;
      }
      return {};
    } catch {
      return {};
    }
  }
  // Legacy plaintext: filter to string-valued entries only.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
