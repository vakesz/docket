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
import { z } from "zod";

export type DiscoveredEndpoints = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
};

const WELL_KNOWN = "/.well-known/oauth-authorization-server";

// RFC 8414 metadata. We only require the two endpoints we actually drive a
// flow through; everything else is best-effort. Unknown / non-string array
// entries in `scopes_supported` are dropped silently because some servers
// return mixed-type arrays.
const DiscoveryMetadataSchema = z.object({
  issuer: z.string().optional(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  scopes_supported: z
    .array(z.unknown())
    .optional()
    .transform((arr) => arr?.filter((s): s is string => typeof s === "string")),
});

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
  const raw: unknown = await res.json();
  const parsed = DiscoveryMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`oauth discovery at ${metadataUrl} missing authorization/token endpoints`);
  }
  const meta = parsed.data;
  return {
    issuer: meta.issuer ?? origin,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    ...(meta.registration_endpoint !== undefined
      ? { registrationEndpoint: meta.registration_endpoint }
      : {}),
    ...(meta.scopes_supported !== undefined && meta.scopes_supported.length > 0
      ? { scopesSupported: meta.scopes_supported }
      : {}),
  };
}
