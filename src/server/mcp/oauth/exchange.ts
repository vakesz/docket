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

export type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
  scope: string | null;
};

function parseTokenResponse(raw: Record<string, unknown>): TokenResponse {
  if (typeof raw.access_token !== "string") {
    throw new Error("oauth token response missing access_token");
  }
  return {
    accessToken: raw.access_token,
    refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : null,
    expiresInSec: typeof raw.expires_in === "number" ? raw.expires_in : null,
    scope: typeof raw.scope === "string" ? raw.scope : null,
  };
}

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
    const basic = Buffer.from(`${form.client_id}:${clientSecret}`).toString("base64");
    headers.authorization = `Basic ${basic}`;
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: new URLSearchParams(form).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const detail = typeof body.error === "string" ? body.error : `${res.status} ${res.statusText}`;
    throw new Error(`oauth token exchange failed: ${detail}`);
  }
  return parseTokenResponse(body);
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
  if (args.scopes) form.scope = args.scopes;
  return postForm(args.tokenEndpoint, form, args.clientSecret);
}
