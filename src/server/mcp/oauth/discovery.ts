/**
 * MCP OAuth discovery (RFC 8414 / OpenID Connect Discovery).
 *
 * Given a server URL like `https://mcp.linear.app/mcp`, derive the
 * issuer origin and fetch `/.well-known/oauth-authorization-server`. The
 * MCP spec uses standard OAuth 2.1 metadata, so this works against
 * Linear, Notion, Atlassian, Sentry, and any future server that follows
 * the spec.
 */

import "server-only";

export type DiscoveredEndpoints = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
};

const WELL_KNOWN = "/.well-known/oauth-authorization-server";

/** Pull the origin from a server URL, dropping any path / query. */
export function originOf(serverUrl: string): string {
  const u = new URL(serverUrl);
  return `${u.protocol}//${u.host}`;
}

export async function discoverOauthEndpoints(serverUrl: string): Promise<DiscoveredEndpoints> {
  const origin = originOf(serverUrl);
  const metadataUrl = `${origin}${WELL_KNOWN}`;
  const res = await fetch(metadataUrl, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(
      `oauth discovery failed: ${metadataUrl} returned ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as Record<string, unknown>;
  const authorizationEndpoint = body.authorization_endpoint;
  const tokenEndpoint = body.token_endpoint;
  if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
    throw new Error(`oauth discovery at ${metadataUrl} missing authorization/token endpoints`);
  }
  const scopesSupported = Array.isArray(body.scopes_supported)
    ? body.scopes_supported.filter((s): s is string => typeof s === "string")
    : undefined;
  return {
    issuer: typeof body.issuer === "string" ? body.issuer : origin,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint:
      typeof body.registration_endpoint === "string" ? body.registration_endpoint : undefined,
    scopesSupported,
  };
}
