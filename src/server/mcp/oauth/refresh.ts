/**
 * In-place OAuth access-token refresh for MCP server rows.
 *
 * Called from `src/agent/mcp/tools.ts` immediately before listing tools
 * on each enabled row. If the row is OAuth-backed and the access token
 * is within 60 seconds of expiry, we use the refresh token to mint a
 * fresh one and persist the result (encrypted `Authorization` header,
 * new `oauthAccessExpiresAt`). Returns the updated row, or `null` if no
 * refresh was needed / the row is not OAuth-backed. On refresh failure
 * the row is disabled so the agent doesn't keep re-trying with a stale
 * bearer; the user has to reconnect via the settings UI.
 */

import "server-only";
import type { McpServerConfig } from "@/db/generated/client";
import type { db as Db } from "@/server/db";
import { logger } from "@/server/logger";
import { decodeHeaders, encodeHeaders } from "@/server/mcp/headers-codec";
import { refreshAccessToken } from "@/server/mcp/oauth/exchange";
import { decryptSecret, encryptSecret } from "@/server/secrets/encryption";

const REFRESH_SLACK_MS = 60 * 1000;

function needsRefresh(row: McpServerConfig): boolean {
  if (!row.oauthRefreshToken) return false;
  if (!row.oauthAccessExpiresAt) return true;
  return row.oauthAccessExpiresAt.getTime() - Date.now() < REFRESH_SLACK_MS;
}

export async function ensureFreshAccessToken(
  db: typeof Db,
  row: McpServerConfig,
): Promise<McpServerConfig | null> {
  if (!row.oauthIssuer || !row.oauthClientId) return null;
  if (!row.oauthRefreshToken) return null;
  if (!needsRefresh(row)) return null;

  try {
    const clientSecret = row.oauthClientSecret ? decryptSecret(row.oauthClientSecret) : null;
    const refreshToken = decryptSecret(row.oauthRefreshToken);
    const tokenEndpoint = await loadTokenEndpoint(row.oauthIssuer);
    const tokens = await refreshAccessToken({
      tokenEndpoint,
      refreshToken,
      clientId: decryptSecret(row.oauthClientId),
      clientSecret,
      scopes: row.oauthScopes,
    });
    const headers = decodeHeaders(row.headersJson);
    headers.Authorization = `Bearer ${tokens.accessToken}`;
    const expiresAt = tokens.expiresInSec
      ? new Date(Date.now() + tokens.expiresInSec * 1000)
      : null;
    return await db.mcpServerConfig.update({
      where: { id: row.id },
      data: {
        headersJson: encodeHeaders(headers),
        oauthAccessExpiresAt: expiresAt,
        oauthRefreshToken: tokens.refreshToken
          ? encryptSecret(tokens.refreshToken)
          : row.oauthRefreshToken,
      },
    });
  } catch (err) {
    logger.warn(
      {
        mcpServerId: row.id,
        projectId: row.projectId,
        err: err instanceof Error ? err.message : String(err),
      },
      "mcp.oauth: refresh failed; disabling row",
    );
    await db.mcpServerConfig.update({
      where: { id: row.id },
      data: { enabled: false },
    });
    return null;
  }
}

const tokenEndpointCache = new Map<string, { endpoint: string; cachedAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function loadTokenEndpoint(issuer: string): Promise<string> {
  const cached = tokenEndpointCache.get(issuer);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.endpoint;
  const { discoverOauthEndpoints } = await import("@/server/mcp/oauth/discovery");
  const meta = await discoverOauthEndpoints(issuer);
  tokenEndpointCache.set(issuer, { endpoint: meta.tokenEndpoint, cachedAt: Date.now() });
  return meta.tokenEndpoint;
}
