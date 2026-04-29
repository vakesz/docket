/**
 * PKCE (RFC 7636) helpers for the MCP OAuth flow.
 *
 * `generatePkcePair` produces a random verifier and the S256 challenge
 * derived from it. The verifier stays in `McpOauthState` for the duration
 * of the handshake; only the challenge travels with the authorization
 * request, so a leaked URL can't be replayed without DB access.
 */

import "server-only";
import { createHash, randomBytes } from "node:crypto";

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  // 32 random bytes → 43-char base64url, well within RFC 7636's 43-128.
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function generateNonce(): string {
  return base64UrlEncode(randomBytes(24));
}
