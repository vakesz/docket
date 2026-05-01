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
import type { ProjectId, UserId } from "@/core/types";
import type { db as Db } from "@/server/db";

export type ToolContext = {
  db: typeof Db;
  projectId: ProjectId;
  userId: UserId;
  /** Optional item this conversation is anchored on. */
  itemId: string | null;
  /** The item's providerItemId, when itemId is set. Convenience for tools. */
  providerItemId: string | null;
};

/**
 * Trust classification for a tool's result, consumed by the agent loop's
 * tool-result guardrail check. Determines what (if anything) the LLM judge
 * sees before re-feeding the result to the chat model.
 *
 *   - `skip`: the result contains only server-generated, structured
 *     metadata (proposal ids, our own echoed question text, audit ids).
 *     There is no path for foreign content, so a guardrail call is pure
 *     noise — it costs tokens and risks false-positive blocks on opaque
 *     JSON. The loop short-circuits before calling the adapter.
 *   - `full` (default when omitted): scan the entire stringified payload.
 *     Right for tools whose result is mostly untrusted text (`web_fetch`,
 *     dynamic MCP tools).
 *   - `fields`: scan only the listed dotted paths inside `result.data`.
 *     For tools whose envelope mixes server metadata with one or two
 *     untrusted text fields (e.g. `get_item` carries server ids alongside
 *     `description` and `comments[].body`). Empty extraction
 *     short-circuits the same way `skip` does.
 *
 * The default (`full`) is fail-safe: any tool that forgets to tag itself
 * still gets scanned exactly as before.
 */
export type GuardrailScan =
  | { mode: "skip" }
  | { mode: "full" }
  | { mode: "fields"; untrusted: readonly string[] };

export type AgentTool = {
  def: LlmToolDef;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  /** Optional. Defaults to `{ mode: "full" }` when omitted. */
  guardrailScan?: GuardrailScan;
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
