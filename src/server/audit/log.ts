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
 * extend this module — don't add `db.audit.create` calls elsewhere.
 */

import "server-only";
import type { Prisma } from "@/db/generated/client";
import type { db as Db } from "@/server/db";
import { errFields } from "@/server/log-fields";
import { logger } from "@/server/logger";

type WriteArgs = {
  db: typeof Db;
  projectId: string;
  userId: string;
  action: string;
  payload: Prisma.InputJsonValue;
};

async function writeAudit(args: WriteArgs): Promise<void> {
  try {
    await args.db.audit.create({
      data: {
        projectId: args.projectId,
        userId: args.userId,
        action: args.action,
        payload: args.payload,
      },
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
  db: typeof Db;
  projectId: string;
  userId: string;
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
  db: typeof Db;
  projectId: string;
  userId: string;
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
