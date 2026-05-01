/**
 * Adapt configured MCP servers into AgentTool[].
 *
 * Pulls every enabled `McpServerConfig` for the project, lists the tools
 * each one advertises, and turns each remote tool into an `AgentTool` the
 * registry can hand to the LLM. Tool names are namespaced
 * `${serverName}__${toolName}` so two servers can both expose `search`
 * without colliding.
 *
 * Servers that fail to connect or list tools are *skipped*, not fatal —
 * a typo in one URL shouldn't take the whole agent down. We log via the
 * structured logger so the operator sees something in the server log and
 * can fix the config; the agent loop keeps the rest of the registry
 * intact.
 */

import "server-only";
import { callMcpTool, listMcpTools, type McpServer } from "@/agent/mcp/client";
import type { AgentTool, ToolContext } from "@/agent/tools/types";
import { fail, ok } from "@/agent/tools/types";
import { errFields } from "@/server/log-fields";
import { logger } from "@/server/logger";
import { decodeHeaders } from "@/server/mcp/headers-codec";
import { ensureFreshAccessToken } from "@/server/mcp/oauth/refresh";

const SEPARATOR = "__";

async function loadServers(ctx: ToolContext): Promise<McpServer[]> {
  const rows = await ctx.db.mcpServerConfig.findMany({
    where: { projectId: ctx.projectId, enabled: true },
    orderBy: [{ name: "asc" }],
  });
  const servers: McpServer[] = [];
  for (const row of rows) {
    // OAuth-backed rows refresh their access token in-place before we
    // connect — keeps the agent loop from carrying a transparently-expired
    // bearer into a remote MCP request.
    const refreshed = await ensureFreshAccessToken(ctx.db, row);
    const headersRow = refreshed ?? row;
    servers.push({
      id: headersRow.id,
      name: headersRow.name,
      url: headersRow.url,
      headers: decodeHeaders(headersRow.headersJson),
    });
  }
  return servers;
}

function adaptTool(
  server: McpServer,
  schema: { name: string; description: string; inputSchema: Record<string, unknown> },
): AgentTool {
  const namespacedName = `${server.name}${SEPARATOR}${schema.name}`;
  return {
    def: {
      name: namespacedName,
      description: schema.description || `MCP tool '${schema.name}' on server '${server.name}'`,
      parameters: schema.inputSchema,
    },
    // MCP tools wrap arbitrary remote payloads — we have no schema to
    // tell which fields are foreign and which are server-controlled. Full
    // scan it is. Tagged explicitly so the registry-coverage arch test
    // can confirm no MCP tool slips through unclassified.
    guardrailScan: { mode: "full" },
    handler: async (raw) => {
      try {
        const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const result = await callMcpTool(server, schema.name, args);
        return result.ok ? ok({ text: result.text }) : fail(result.text || "MCP tool failed");
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/**
 * Build one AgentTool per enabled remote tool. Servers that fail to
 * connect / list are dropped from the resulting array.
 */
export async function mcpTools(ctx: ToolContext): Promise<AgentTool[]> {
  const servers = await loadServers(ctx);
  if (servers.length === 0) return [];

  const groups = await Promise.all(
    servers.map(async (server) => {
      try {
        const schemas = await listMcpTools(server);
        return schemas.map((schema) => adaptTool(server, schema));
      } catch (err) {
        logger.warn(
          {
            projectId: ctx.projectId,
            mcpServerId: server.id,
            mcpServerName: server.name,
            mcpServerUrl: server.url,
            ...errFields(err),
          },
          "mcp: list tools failed; skipping server",
        );
        return [];
      }
    }),
  );
  return groups.flat();
}
