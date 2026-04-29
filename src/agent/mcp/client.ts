/**
 * Thin HTTP MCP client wrapper.
 *
 * Wraps `@modelcontextprotocol/sdk` so the agent loop can talk to a remote
 * MCP server with one connect → list → call → close cycle per turn. We
 * deliberately do not keep a long-lived connection: each agent loop
 * builds the tool registry fresh, lists tools off each enabled server,
 * and tears connections down at the end. That keeps the agent stateless
 * and avoids drift between the cached tool schema and what the server
 * currently advertises.
 *
 * stdio is intentionally not supported — every MCP server has to be
 * reachable over HTTP / streamable HTTP.
 */

import "server-only";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export type McpServer = {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
};

export type McpToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/**
 * Connect to an HTTP MCP server, run `fn`, and close the transport on the
 * way out. Errors propagate so the caller (tool registry) can decide
 * whether to fail soft or hard.
 */
export async function withMcpClient<T>(
  server: McpServer,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(
    new URL(server.url),
    Object.keys(server.headers).length > 0 ? { requestInit: { headers: server.headers } } : {},
  );
  const client = new Client({ name: "docket", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport as unknown as Transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {
      // Closing a transport that already errored shouldn't mask the
      // original error; swallow secondary close failures.
    });
  }
}

/**
 * List the tools an HTTP MCP server advertises. Returns the names,
 * descriptions, and input JSON Schemas — exactly what the agent's
 * tool registry needs to expose them to the LLM.
 */
export async function listMcpTools(server: McpServer): Promise<McpToolSchema[]> {
  return withMcpClient(server, async (client) => {
    const result = await client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  });
}

/**
 * Invoke one tool on an HTTP MCP server and return the result content.
 * The MCP `content` array is flattened to a single text payload — that's
 * what fits cleanly into the agent loop's `tool_call_completed` event.
 */
export async function callMcpTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; text: string }> {
  return withMcpClient(server, async (client) => {
    const result = await client.callTool({
      name: toolName,
      arguments: args,
    });
    const isError = Boolean(result.isError);
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((c) => {
        if (typeof c !== "object" || c === null) return "";
        const obj = c as { type?: string; text?: string };
        if (obj.type === "text" && typeof obj.text === "string") return obj.text;
        return JSON.stringify(c);
      })
      .filter(Boolean)
      .join("\n");
    return { ok: !isError, text };
  });
}
