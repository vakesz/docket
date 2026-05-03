/**
 * Encrypt MCP server headers at rest.
 *
 * `McpServerConfig.headersJson` carries auth tokens (PATs, OAuth bearer
 * tokens). The whole headers object is serialized to JSON, encrypted via
 * `enc:v1:` from `secrets/encryption.ts`, and stored under a single
 * `_enc` key so Prisma's `Json` typing stays untouched. An empty headers
 * object is stored as `{}` (no point spending an IV on nothing).
 */

import "server-only";
import { asPlainObject, parseStringMap } from "@/lib/json";
import { decryptSecret, encryptSecret } from "@/server/secrets/encryption";

const ENC_KEY = "_enc";

export type EncodedHeaders = Record<string, string> | { [ENC_KEY]: string };

/** Encode a plaintext headers map for storage. Empty stays empty. */
export function encodeHeaders(plain: Record<string, string>): EncodedHeaders {
  const keys = Object.keys(plain);
  if (keys.length === 0) return {};
  const blob = encryptSecret(JSON.stringify(plain));
  return { [ENC_KEY]: blob };
}

/**
 * Decode a stored headers value. Accepts:
 *   - `{ _enc: "enc:v1:..." }` — encrypted (the only write format)
 *   - `{}` / null / undefined  — empty
 */
export function decodeHeaders(stored: unknown): Record<string, string> {
  const enc = asPlainObject(stored)[ENC_KEY];
  if (typeof enc !== "string") return {};
  try {
    return parseStringMap(JSON.parse(decryptSecret(enc))) ?? {};
  } catch {
    return {};
  }
}
