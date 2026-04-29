/**
 * Compute the static OAuth redirect URI for MCP server handshakes.
 *
 * One redirect URI for every MCP server in every project — we route to
 * the right `McpServerConfig` row via the random `state` nonce stored
 * in `McpOauthState`. The base URL comes from `AUTH_URL` (already used
 * by NextAuth) so dev / docker / prod all resolve correctly.
 */

import "server-only";

const PATH = "/api/mcp/oauth/callback";

export function mcpOauthRedirectUri(): string {
  const base = process.env.AUTH_URL?.trim() || process.env.NEXTAUTH_URL?.trim();
  if (!base) {
    throw new Error("MCP OAuth redirect URI requires AUTH_URL (or NEXTAUTH_URL) to be set");
  }
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}${PATH}`;
}
