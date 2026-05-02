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
import { z } from "zod";

export type RegistrationResult = {
  clientId: string;
  clientSecret: string | null;
};

// RFC 7591 §3.2.1 dynamic client registration response. Only `client_id` is
// mandatory in our flow; servers using `token_endpoint_auth_method: "none"`
// (the public-client path) won't return `client_secret`.
const RegistrationResponseSchema = z
  .object({
    client_id: z.string(),
    client_secret: z.string().nullish(),
  })
  .transform((raw) => ({
    clientId: raw.client_id,
    clientSecret: raw.client_secret ?? null,
  }));

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
  const raw: unknown = await res.json();
  const parsed = RegistrationResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("oauth dynamic client registration: response missing client_id");
  }
  return parsed.data;
}
