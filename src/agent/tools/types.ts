/**
 * Internal types for the agent tool layer.
 *
 * Each tool is a `{ def, handler }` pair: `def` is the JSON Schema the LLM
 * sees in its tools list; `handler` is the async function the loop invokes
 * when the model emits a tool call. Tools may close over context (db,
 * projectId, userId) — that's why factories accept `ToolContext` instead
 * of bare arguments.
 */

import type { LlmToolDef } from "@/agent/llm/types";
import type { db as Db } from "@/server/db";

export type ToolContext = {
  db: typeof Db;
  projectId: string;
  userId: string;
  /** Optional item this conversation is anchored on. */
  itemId: string | null;
  /** The item's providerItemId, when itemId is set. Convenience for tools. */
  providerItemId: string | null;
};

export type AgentTool = {
  def: LlmToolDef;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

export type ToolFactory = (ctx: ToolContext) => AgentTool;

/**
 * Stable result envelope every tool returns. The agent re-feeds this as
 * the next-turn `tool` message — keeping the shape uniform makes it easy
 * for the model to learn the pattern across tools.
 */
export type ToolResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

export function fail(error: string): ToolResult<never> {
  return { ok: false, error };
}
