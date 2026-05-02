import { relations } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ProjectId, UserId } from "@/core/types";
import { emptyJsonbObject, fkUuid, pkUuid, timestamps } from "@/db/columns";
import { projects } from "@/db/schema/projects";

export type McpHeadersJson = Record<string, string> & {
  /** Encoded blob produced by `src/server/mcp/headers-codec.ts`. */
  _enc?: string;
};

export const mcpServerConfigs = pgTable(
  "mcp_server_configs",
  {
    id: pkUuid(),
    projectId: fkUuid<ProjectId>(() => projects.id, "cascade"),
    name: text().notNull(),
    // 'http' only — stdio transport is intentionally not supported because
    // running operator-supplied subprocesses server-side is a security
    // problem. Column shape accepts other transports without a migration.
    transport: text().notNull().default("http"),
    url: text().notNull(),
    // Optional headers (auth tokens, etc). Encrypted at rest via the
    // `_enc` blob shape produced by `src/server/mcp/headers-codec.ts`,
    // keyed by `SECRETS_KEY`.
    headersJson: emptyJsonbObject<McpHeadersJson>(),
    enabled: boolean().notNull().default(true),
    // OAuth state (when this server was connected via the OAuth flow).
    // `oauthIssuer` doubles as the discovery base URL — a present value
    // means the row is OAuth-backed and `Authorization` in `headersJson`
    // was minted by `confirmOauth`.
    oauthIssuer: text(),
    // `enc:v1:` ciphertext. Issued by dynamic client registration (RFC 7591)
    // or pasted by an admin for static-client deployments.
    oauthClientId: text(),
    oauthClientSecret: text(),
    // Space-separated scopes from the original consent.
    oauthScopes: text(),
    oauthRefreshToken: text(),
    // Wall-clock expiry of the access token currently in `headersJson`.
    // Refresh fires when `now() >= expiresAt - 60s`.
    oauthAccessExpiresAt: timestamp({ withTimezone: true, mode: "date" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("mcp_server_configs_project_name_idx").on(t.projectId, t.name),
    index("mcp_server_configs_project_enabled_idx").on(t.projectId, t.enabled),
  ],
);

// Short-lived OAuth handshake state for MCP servers. Holds the PKCE
// verifier between the authorization-redirect and the callback so the
// token exchange can run without trusting the URL fragment. Rows are
// reaped on TTL by the next handshake.
export const mcpOauthStates = pgTable(
  "mcp_oauth_states",
  {
    id: pkUuid(),
    nonce: text().notNull().unique(),
    // Soft references — these handshake records are short-lived (TTL-reaped)
    // and don't justify FKs that would force handshake cleanup on project /
    // user deletion. Match the previous schema's `String` columns.
    projectId: uuid().$type<ProjectId>().notNull(),
    userId: uuid().$type<UserId>().notNull(),
    mcpServerId: text().notNull(),
    // PKCE code-verifier (RFC 7636), base64url. The challenge is derived
    // from this and sent on the authorization request.
    codeVerifier: text().notNull(),
    issuer: text().notNull(),
    tokenEndpoint: text().notNull(),
    clientId: text().notNull(),
    // `enc:v1:` ciphertext of the client secret if one was issued.
    clientSecret: text(),
    scopes: text().notNull(),
    redirectUri: text().notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("mcp_oauth_states_expires_at_idx").on(t.expiresAt)],
);

export const mcpServerConfigsRelations = relations(mcpServerConfigs, ({ one }) => ({
  project: one(projects, {
    fields: [mcpServerConfigs.projectId],
    references: [projects.id],
  }),
}));
