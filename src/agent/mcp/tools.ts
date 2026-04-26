/**
 * Adapt configured MCP servers into AgentTool[] (Phase 8).
 *
 * Pulls every enabled `McpServerConfig` for the project, lists the tools
 * each one advertises, and turns each remote tool into an `AgentTool` the
 * registry can hand to the LLM. Tool names are namespaced
 * `${serverName}__${toolName}` so two servers can both expose `search`
 * without colliding.
 *
 * Servers that fail to connect or list tools are *skipped*, not fatal —
 * a typo in one URL shouldn't take the whole agent down. We log a
 * `console.warn` so the operator sees something in the server log and
 * can fix the config; the agent loop keeps the rest of the registry
 * intact.
 */

import "server-only";
import { callMcpTool, listMcpTools, type McpServer } from "@/agent/mcp/client";
import type { AgentTool, ToolContext } from "@/agent/tools/types";
import { fail, ok } from "@/agent/tools/types";

const SEPARATOR = "__";

async function loadServers(ctx: ToolContext): Promise<McpServer[]> {
  const rows = await ctx.db.mcpServerConfig.findMany({
    where: { projectId: ctx.projectId, enabled: true },
    orderBy: [{ name: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    url: row.url,
    headers:
      row.headersJson && typeof row.headersJson === "object" && !Array.isArray(row.headersJson)
        ? (row.headersJson as Record<string, string>)
        : {},
  }));
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
        console.warn(
          `[mcp] failed to list tools on '${server.name}' (${server.url}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return [];
      }
    }),
  );
  return groups.flat();
}
