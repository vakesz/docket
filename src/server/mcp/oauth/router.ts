/**
 * MCP OAuth handshake router.
 *
 * Two-step flow:
 *   1. `start` — discover endpoints, register a client (DCR) if needed,
 *      generate PKCE + nonce, persist `McpOauthState`, return the
 *      authorization URL the UI should open in a popup.
 *   2. `complete` — invoked from the callback Next route handler. Looks
 *      up the state by nonce, exchanges the code for tokens, encrypts
 *      and writes them onto the `McpServerConfig` row, enables the row,
 *      drops the audit trail, and deletes the state row.
 *
 * Token storage:
 *   - `Authorization: Bearer <access>` lives in `headersJson` (encrypted
 *     via `headers-codec`) so the agent loop reads it the same way as
 *     any manually-pasted bearer token.
 *   - `oauthRefreshToken`, `oauthClientId`, `oauthClientSecret` are
 *     `enc:v1:` encrypted on the row directly via `secrets/encryption.ts`.
 */

import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { recordMcpOauthConnected, recordMcpOauthDisconnected } from "@/server/audit/log";
import { decodeHeaders, encodeHeaders } from "@/server/mcp/headers-codec";
import { discoverOauthEndpoints } from "@/server/mcp/oauth/discovery";
import { exchangeAuthCode } from "@/server/mcp/oauth/exchange";
import { generateNonce, generatePkcePair } from "@/server/mcp/oauth/pkce";
import { mcpOauthRedirectUri } from "@/server/mcp/oauth/redirect-uri";
import { registerOauthClient } from "@/server/mcp/oauth/register";
import { decryptSecret, encryptSecret } from "@/server/secrets/encryption";
import {
  projectIdSchema,
  projectScopedMutationProcedure,
  router,
  userIdOrThrow,
} from "@/server/trpc";

const STATE_TTL_MS = 10 * 60 * 1000;

const StartInput = projectIdSchema.extend({
  serverId: z.string().min(1),
  /// Optional pre-registered client credentials. Used when DCR is
  /// disabled at the IdP and the operator has registered an OAuth client
  /// out of band. Server falls back to DCR when omitted.
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  /// Optional space-separated scope override. When omitted, all scopes
  /// advertised in discovery metadata are requested.
  scopes: z.string().optional(),
});

const CompleteInput = z.object({
  nonce: z.string().min(1),
  code: z.string().min(1),
});

export const mcpOauthRouter = router({
  start: projectScopedMutationProcedure.input(StartInput).mutation(async ({ ctx, input }) => {
    const userId = userIdOrThrow(ctx);
    const row = await ctx.db.mcpServerConfig.findFirst({
      where: { id: input.serverId, projectId: ctx.projectId },
    });
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
    }

    const meta = await discoverOauthEndpoints(row.url);
    const redirectUri = mcpOauthRedirectUri();
    const scopesArr = (input.scopes ?? meta.scopesSupported?.join(" ") ?? "").trim();
    const scopes = scopesArr === "" ? "" : scopesArr;

    let clientId: string;
    let clientSecret: string | null;
    if (input.clientId) {
      clientId = input.clientId;
      clientSecret = input.clientSecret ?? null;
    } else {
      if (!meta.registrationEndpoint) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "MCP server does not support dynamic client registration; provide clientId / clientSecret",
        });
      }
      const dcr = await registerOauthClient(
        meta.registrationEndpoint,
        redirectUri,
        scopes ? scopes.split(/\s+/) : [],
      );
      clientId = dcr.clientId;
      clientSecret = dcr.clientSecret;
    }

    const { verifier, challenge } = generatePkcePair();
    const nonce = generateNonce();

    await ctx.db.mcpOauthState.create({
      data: {
        nonce,
        projectId: ctx.projectId,
        userId,
        mcpServerId: row.id,
        codeVerifier: verifier,
        issuer: meta.issuer,
        tokenEndpoint: meta.tokenEndpoint,
        clientId: encryptSecret(clientId),
        clientSecret: clientSecret ? encryptSecret(clientSecret) : null,
        scopes,
        redirectUri,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });

    const authUrl = new URL(meta.authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", nonce);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    if (scopes) authUrl.searchParams.set("scope", scopes);

    return { authorizationUrl: authUrl.toString() };
  }),

  /**
   * Drop OAuth tokens from a server row. Called from the editor's
   * "Disconnect" button. The row stays — the user might want to manually
   * paste a token afterwards — but its `Authorization` header and OAuth
   * fields are cleared and the row is disabled.
   */
  disconnect: projectScopedMutationProcedure
    .input(projectIdSchema.extend({ serverId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const userId = userIdOrThrow(ctx);
      const row = await ctx.db.mcpServerConfig.findFirst({
        where: { id: input.serverId, projectId: ctx.projectId },
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
      }
      const headers = decodeHeaders(row.headersJson);
      delete headers.Authorization;
      const updated = await ctx.db.mcpServerConfig.update({
        where: { id: row.id },
        data: {
          headersJson: encodeHeaders(headers),
          enabled: false,
          oauthIssuer: null,
          oauthClientId: null,
          oauthClientSecret: null,
          oauthScopes: null,
          oauthRefreshToken: null,
          oauthAccessExpiresAt: null,
        },
      });
      await recordMcpOauthDisconnected({
        db: ctx.db,
        projectId: ctx.projectId,
        userId,
        mcpServerId: updated.id,
        mcpServerName: updated.name,
      });
      return { id: updated.id };
    }),
});

/**
 * Callback-side completion. Called from the Next route handler at
 * `/api/mcp/oauth/callback` — not a tRPC procedure because the redirect
 * lands as a top-level GET, not a tRPC POST. Auth is by the random
 * nonce the IdP echoes back (state is the row id by another name); we
 * reject if the session user doesn't match the row's `userId`.
 */
export async function completeMcpOauth(args: {
  db: typeof import("@/server/db").db;
  sessionUserId: string;
  nonce: string;
  code: string;
}): Promise<{ projectId: string; mcpServerId: string }> {
  const parsed = CompleteInput.parse({ nonce: args.nonce, code: args.code });
  const state = await args.db.mcpOauthState.findUnique({ where: { nonce: parsed.nonce } });
  if (!state) {
    throw new Error("oauth callback: state not found (already used or expired)");
  }
  if (state.expiresAt.getTime() < Date.now()) {
    await args.db.mcpOauthState.delete({ where: { id: state.id } });
    throw new Error("oauth callback: state expired");
  }
  if (state.userId !== args.sessionUserId) {
    throw new Error("oauth callback: state belongs to a different user");
  }

  const tokens = await exchangeAuthCode({
    tokenEndpoint: state.tokenEndpoint,
    code: parsed.code,
    redirectUri: state.redirectUri,
    clientId: decryptSecret(state.clientId),
    clientSecret: state.clientSecret ? decryptSecret(state.clientSecret) : null,
    codeVerifier: state.codeVerifier,
  });

  const row = await args.db.mcpServerConfig.findFirst({
    where: { id: state.mcpServerId, projectId: state.projectId },
  });
  if (!row) {
    await args.db.mcpOauthState.delete({ where: { id: state.id } });
    throw new Error("oauth callback: server row no longer exists");
  }

  const headers = decodeHeaders(row.headersJson);
  headers.Authorization = `Bearer ${tokens.accessToken}`;
  const expiresAt = tokens.expiresInSec ? new Date(Date.now() + tokens.expiresInSec * 1000) : null;
  const scopes = tokens.scope ?? state.scopes;

  await args.db.mcpServerConfig.update({
    where: { id: row.id },
    data: {
      headersJson: encodeHeaders(headers),
      enabled: true,
      oauthIssuer: state.issuer,
      oauthClientId: state.clientId,
      oauthClientSecret: state.clientSecret,
      oauthScopes: scopes,
      oauthRefreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      oauthAccessExpiresAt: expiresAt,
    },
  });
  await args.db.mcpOauthState.delete({ where: { id: state.id } });

  await recordMcpOauthConnected({
    db: args.db,
    projectId: state.projectId,
    userId: state.userId,
    mcpServerId: row.id,
    mcpServerName: row.name,
    issuer: state.issuer,
    scopes,
  });

  return { projectId: state.projectId, mcpServerId: row.id };
}
