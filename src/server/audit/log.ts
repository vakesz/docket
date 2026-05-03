/**
 * Non-proposal audit writers.
 *
 * The proposal executor (`src/server/proposals/executor.ts`) is the
 * canonical audit writer for confirmed/rejected provider mutations.
 * That covers most of what the audit log needs to remember, but not
 * every audit-worthy event flows through a proposal — connecting an
 * MCP server via OAuth, for instance, mutates configuration in the
 * `McpServerConfig` table directly. Those events land here so audit
 * writes still funnel through one tiny module instead of leaking into
 * routers.
 *
 * Allowed callers are listed in
 * `src/__arch__/no-audit-write-leak.test.ts`. To add a new event,
 * extend this module — don't add `db.insert(audits)` calls elsewhere.
 */

import "server-only";
import type { ProjectId, ProposalId, UserId } from "@/core/types";
import type { Db } from "@/db";
import { audits } from "@/db/schema";
import { errFields } from "@/server/log-fields";
import { logger } from "@/server/logger";

/**
 * Closed set of audit actions. Every audit row's `action` column is one of
 * these literal strings; adding a new event means adding it here first so the
 * compiler refuses typos at every call site (`"proposal.confrim"` no longer
 * compiles). When you add a value, also extend `AUDIT_ACTIONS` so the
 * runtime guard can validate persisted rows on the way back in.
 */
export const AUDIT_ACTIONS = [
  "proposal.confirm",
  "proposal.confirm.failed",
  "proposal.auto_confirm",
  "proposal.auto_confirm.failed",
  "proposal.reject",
  "mcp.oauth.connected",
  "mcp.oauth.disconnected",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

type WriteArgs = {
  db: Db;
  projectId: ProjectId;
  userId: UserId;
  action: AuditAction;
  proposalId?: ProposalId;
  payload: Record<string, unknown>;
};

async function writeAudit(args: WriteArgs): Promise<void> {
  try {
    await args.db.insert(audits).values({
      projectId: args.projectId,
      userId: args.userId,
      action: args.action,
      ...(args.proposalId ? { proposalId: args.proposalId } : {}),
      payload: args.payload,
    });
  } catch (err) {
    logger.error(
      {
        projectId: args.projectId,
        userId: args.userId,
        action: args.action,
        ...errFields(err),
      },
      "audit: write failed",
    );
  }
}

export async function recordMcpOauthConnected(args: {
  db: Db;
  projectId: ProjectId;
  userId: UserId;
  mcpServerId: string;
  mcpServerName: string;
  issuer: string;
  scopes: string;
}): Promise<void> {
  await writeAudit({
    db: args.db,
    projectId: args.projectId,
    userId: args.userId,
    action: "mcp.oauth.connected",
    payload: {
      mcpServerId: args.mcpServerId,
      mcpServerName: args.mcpServerName,
      issuer: args.issuer,
      scopes: args.scopes,
    },
  });
}

export async function recordMcpOauthDisconnected(args: {
  db: Db;
  projectId: ProjectId;
  userId: UserId;
  mcpServerId: string;
  mcpServerName: string;
}): Promise<void> {
  await writeAudit({
    db: args.db,
    projectId: args.projectId,
    userId: args.userId,
    action: "mcp.oauth.disconnected",
    payload: {
      mcpServerId: args.mcpServerId,
      mcpServerName: args.mcpServerName,
    },
  });
}
