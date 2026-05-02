// `Authorization: Bearer <access>` lives in `headersJson` (encrypted via
// `headers-codec`) so the agent loop reads it the same way as any manually
// pasted bearer token. `oauthRefreshToken`, `oauthClientId`,
// `oauthClientSecret` are `enc:v1:` encrypted directly on the row.

import "server-only";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ProjectId, UserId } from "@/core/types";
import type { Db } from "@/db";
import { mcpOauthStates, mcpServerConfigs, projects } from "@/db/schema";
import { recordMcpOauthConnected, recordMcpOauthDisconnected } from "@/server/audit/log";
import { decodeHeaders, encodeHeaders } from "@/server/mcp/headers-codec";
import { discoverOauthEndpoints } from "@/server/mcp/oauth/discovery";
import { exchangeAuthCode } from "@/server/mcp/oauth/exchange";
import { generateNonce, generatePkcePair } from "@/server/mcp/oauth/pkce";
import { mcpOauthRedirectUri } from "@/server/mcp/oauth/redirect-uri";
import { registerOauthClient } from "@/server/mcp/oauth/register";
import { decryptSecret, encryptSecret } from "@/server/secrets/encryption";
import {
  assertFound,
  projectScopedMutationProcedure,
  projectSlugSchema,
  router,
} from "@/server/trpc";

const STATE_TTL_MS = 10 * 60 * 1000;

const StartInput = projectSlugSchema.extend({
  serverId: z.string().min(1),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scopes: z.string().optional(),
});

const CompleteInput = z.object({
  nonce: z.string().min(1),
  code: z.string().min(1),
});

export const mcpOauthRouter = router({
  start: projectScopedMutationProcedure.input(StartInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
    const row = assertFound(
      await ctx.db.query.mcpServerConfigs.findFirst({
        where: and(
          eq(mcpServerConfigs.id, input.serverId),
          eq(mcpServerConfigs.projectId, ctx.projectId),
        ),
      }),
      "MCP server not found",
    );

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

    await ctx.db.insert(mcpOauthStates).values({
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
   * "Disconnect" button.
   */
  disconnect: projectScopedMutationProcedure
    .input(projectSlugSchema.extend({ serverId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;
      const row = assertFound(
        await ctx.db.query.mcpServerConfigs.findFirst({
          where: and(
            eq(mcpServerConfigs.id, input.serverId),
            eq(mcpServerConfigs.projectId, ctx.projectId),
          ),
        }),
        "MCP server not found",
      );
      const headers = decodeHeaders(row.headersJson);
      delete headers["Authorization"];
      const [updated] = await ctx.db
        .update(mcpServerConfigs)
        .set({
          headersJson: encodeHeaders(headers),
          enabled: false,
          oauthIssuer: null,
          oauthClientId: null,
          oauthClientSecret: null,
          oauthScopes: null,
          oauthRefreshToken: null,
          oauthAccessExpiresAt: null,
        })
        .where(eq(mcpServerConfigs.id, row.id))
        .returning();
      if (!updated) throw new Error("MCP server update returned no row");
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
 * `/api/mcp/oauth/callback`.
 */
export async function completeMcpOauth(args: {
  db: Db;
  sessionUserId: UserId;
  nonce: string;
  code: string;
}): Promise<{ projectId: ProjectId; projectSlug: string; mcpServerId: string }> {
  const parsed = CompleteInput.parse({ nonce: args.nonce, code: args.code });
  const state = await args.db.query.mcpOauthStates.findFirst({
    where: eq(mcpOauthStates.nonce, parsed.nonce),
  });
  if (!state) {
    throw new Error("oauth callback: state not found (already used or expired)");
  }
  if (state.expiresAt.getTime() < Date.now()) {
    await args.db.delete(mcpOauthStates).where(eq(mcpOauthStates.id, state.id));
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

  const row = await args.db.query.mcpServerConfigs.findFirst({
    where: and(
      eq(mcpServerConfigs.id, state.mcpServerId),
      eq(mcpServerConfigs.projectId, state.projectId),
    ),
  });
  if (!row) {
    await args.db.delete(mcpOauthStates).where(eq(mcpOauthStates.id, state.id));
    throw new Error("oauth callback: server row no longer exists");
  }

  const headers = decodeHeaders(row.headersJson);
  headers["Authorization"] = `Bearer ${tokens.accessToken}`;
  const expiresAt = tokens.expiresInSec ? new Date(Date.now() + tokens.expiresInSec * 1000) : null;
  const scopes = tokens.scope ?? state.scopes;

  await args.db
    .update(mcpServerConfigs)
    .set({
      headersJson: encodeHeaders(headers),
      enabled: true,
      oauthIssuer: state.issuer,
      oauthClientId: state.clientId,
      oauthClientSecret: state.clientSecret,
      oauthScopes: scopes,
      oauthRefreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      oauthAccessExpiresAt: expiresAt,
    })
    .where(eq(mcpServerConfigs.id, row.id));
  await args.db.delete(mcpOauthStates).where(eq(mcpOauthStates.id, state.id));

  await recordMcpOauthConnected({
    db: args.db,
    projectId: state.projectId,
    userId: state.userId,
    mcpServerId: row.id,
    mcpServerName: row.name,
    issuer: state.issuer,
    scopes,
  });

  const project = await args.db.query.projects.findFirst({
    where: eq(projects.id, state.projectId),
    columns: { slug: true },
  });
  if (!project) {
    throw new Error("oauth callback: project no longer exists");
  }

  return { projectId: state.projectId, projectSlug: project.slug, mcpServerId: row.id };
}
