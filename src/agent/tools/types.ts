/**
 * Internal types for the agent tool layer.
 *
 * Each tool is a `{ def, handler }` pair: `def` is the JSON Schema the LLM
 * sees in its tools list; `handler` is the async function the loop invokes
 * when the model emits a tool call. Tools may close over context (db,
 * projectId, userId) — that's why factories accept `ToolContext` instead
 * of bare arguments.
 */

import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { LlmToolDef } from "@/agent/llm/types";
import { zodToJsonSchema } from "@/agent/tools/schema";
import type { ItemId, ProjectId, ProviderItemId, UserId } from "@/core/types";
import type { Db } from "@/db";
import { projects } from "@/db/schema";
import { buildProviderForUser } from "@/server/providers/build";

export type ToolContext = {
  db: Db;
  projectId: ProjectId;
  userId: UserId;
  /** Optional item this conversation is anchored on. */
  itemId: ItemId | null;
  /** The item's providerItemId, when itemId is set. Convenience for tools. */
  providerItemId: ProviderItemId | null;
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

/**
 * Stable result envelope every tool returns. The agent re-feeds this as
 * the next-turn `tool` message — keeping the shape uniform makes it easy
 * for the model to learn the pattern across tools.
 */
export type ToolResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export type AgentTool = {
  def: LlmToolDef;
  // The registry erases per-tool data shapes (the loop dispatches by name
  // and the LLM passes raw `unknown`-typed args), so the handler signature
  // is the broadest envelope: `Record<string, unknown>` in, `ToolResult` out.
  // The discriminated `ok | error` shape lets the loop narrow without casts.
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  /** Optional. Defaults to `{ mode: "full" }` when omitted. */
  guardrailScan?: GuardrailScan;
};

export type ToolFactory = (ctx: ToolContext) => AgentTool;

export function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

export function fail(error: string): ToolResult<never> {
  return { ok: false, error };
}

/**
 * Build the project's WorkItemProvider for this conversation and run `fn`
 * against it. Used by every read-only and discovery tool that talks to the
 * upstream provider (PRs, commits, code search, etc.) — keeps the project
 * lookup + provider construction in one place rather than duplicated per
 * tool factory.
 */
export async function withProvider<T>(
  ctx: ToolContext,
  fn: (provider: Awaited<ReturnType<typeof buildProviderForUser>>) => Promise<T>,
): Promise<T> {
  const project = await ctx.db.query.projects.findFirst({
    where: eq(projects.id, ctx.projectId),
  });
  if (!project) throw new Error(`project ${ctx.projectId} not found`);
  const provider = await buildProviderForUser(ctx.db, project, ctx.userId);
  return fn(provider);
}

/**
 * Compose an `AgentTool` from a single zod schema. The schema is the
 * source of truth: it produces both the JSON Schema the LLM sees and the
 * type-safe parsed args the handler receives. Handlers no longer
 * re-declare the schema or run a second `.parse(raw)`.
 */
export function defineTool<S extends z.ZodTypeAny>(spec: {
  name: string;
  description: string;
  schema: S;
  guardrailScan?: GuardrailScan;
  handler: (args: z.infer<S>) => Promise<ToolResult>;
}): AgentTool {
  const tool: AgentTool = {
    def: {
      name: spec.name,
      description: spec.description,
      parameters: zodToJsonSchema(spec.schema),
    },
    handler: async (raw) => spec.handler(spec.schema.parse(raw)),
  };
  if (spec.guardrailScan) tool.guardrailScan = spec.guardrailScan;
  return tool;
}
