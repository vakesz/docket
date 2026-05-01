/**
 * Dynamic client registration (RFC 7591) for MCP OAuth servers.
 *
 * Linear, Notion, and most spec-compliant MCP servers issue client
 * credentials on demand — we POST our redirect URI to the registration
 * endpoint and get back a `client_id` (and optionally `client_secret`).
 * Servers without DCR support require an admin to paste pre-registered
 * credentials before starting the flow.
 */

import "server-only";

export type RegistrationResult = {
  clientId: string;
  clientSecret: string | null;
};

export async function registerOauthClient(
  registrationEndpoint: string,
  redirectUri: string,
  scopes: string[],
): Promise<RegistrationResult> {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Docket",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: scopes.join(" "),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `oauth dynamic client registration failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body["client_id"] !== "string") {
    throw new Error("oauth dynamic client registration: response missing client_id");
  }
  return {
    clientId: body["client_id"],
    clientSecret: typeof body["client_secret"] === "string" ? body["client_secret"] : null,
  };
}
