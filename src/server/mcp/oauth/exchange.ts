/**
 * OAuth 2.1 token endpoint exchange.
 *
 * Two flavors: `exchangeAuthCode` swaps an authorization code for the
 * first access/refresh token pair; `refreshAccessToken` swaps a refresh
 * token for a fresh access token. Both speak `application/x-www-form-
 * urlencoded` per RFC 6749 + RFC 7636 (PKCE) and accept either
 * confidential (`client_secret`) or public (PKCE-only) clients.
 */

import "server-only";
import { z } from "zod";

export type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
  scope: string | null;
};

// RFC 6749 §5.1 token response. `access_token` is the only mandatory field.
const TokenResponseSchema = z
  .object({
    access_token: z.string(),
    refresh_token: z.string().nullish(),
    expires_in: z.number().nullish(),
    scope: z.string().nullish(),
  })
  .transform((raw) => ({
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    expiresInSec: raw.expires_in ?? null,
    scope: raw.scope ?? null,
  }));

const TokenErrorSchema = z.object({ error: z.string().optional() }).catch({ error: undefined });

async function postForm(
  endpoint: string,
  form: Record<string, string>,
  clientSecret: string | null,
): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (clientSecret) {
    const basic = Buffer.from(`${form["client_id"]}:${clientSecret}`).toString("base64");
    headers["authorization"] = `Basic ${basic}`;
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: new URLSearchParams(form).toString(),
  });
  const raw: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errBody = TokenErrorSchema.parse(raw);
    const detail = errBody.error ?? `${res.status} ${res.statusText}`;
    throw new Error(`oauth token exchange failed: ${detail}`);
  }
  const parsed = TokenResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("oauth token response missing access_token");
  }
  return parsed.data;
}

export async function exchangeAuthCode(args: {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string | null;
  codeVerifier: string;
}): Promise<TokenResponse> {
  return postForm(
    args.tokenEndpoint,
    {
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      client_id: args.clientId,
      code_verifier: args.codeVerifier,
    },
    args.clientSecret,
  );
}

export async function refreshAccessToken(args: {
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string | null;
  scopes: string | null;
}): Promise<TokenResponse> {
  const form: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
  };
  if (args.scopes) form["scope"] = args.scopes;
  return postForm(args.tokenEndpoint, form, args.clientSecret);
}
