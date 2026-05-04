// Order is part of the prompt-cache key — reordering or inserting in the
// middle invalidates every open conversation's cache. The arch test in
// `src/__arch__/tool-registration-order.test.ts` pins it so a silent
// reorder fails CI. CLAUDE.md invariant #11 lists the canonical order.
// `readOnly` strips groups (5)–(7); downstream tool calls don't re-check.

import "server-only";
import { mcpTools } from "@/agent/mcp/tools";
import { discoveryTools } from "@/agent/tools/discovery";
import { findRelatedPullRequestsTool } from "@/agent/tools/links";
import { memoryReadonlyTools } from "@/agent/tools/memory";
import { proposeMemoryDeleteTool, proposeMemoryWriteTool } from "@/agent/tools/memory-mutating";
import {
  proposeCommentTool,
  proposeDescriptionPatchTool,
  proposeItemTagsTool,
  proposeNewItemTool,
  proposeTransitionTool,
} from "@/agent/tools/mutating";
import { askUserQuestionTool } from "@/agent/tools/question";
import { readonlyTools } from "@/agent/tools/readonly";
import { sourceReadonlyTools } from "@/agent/tools/source";
import type { AgentTool, ToolContext } from "@/agent/tools/types";
import { webFetchTool } from "@/agent/tools/web-fetch";
import { loadProjectSetting } from "@/server/settings/effective";

export type ToolRegistryOptions = {
  readOnly: boolean;
};

/**
 * Stable tool name list — the *core* (non-MCP) tools, in registration
 * order. Used by the arch test to detect silent reorders. MCP tools land
 * dynamically at slot 5 between source-readonly and provider mutating
 * (one tool per remote tool, namespaced `${serverName}__${toolName}`),
 * so they're not enumerated here. The arch test asserts that
 * non-MCP names appear in this exact order regardless of how many MCP
 * tools sit between source-readonly and provider mutating.
 */
export const TOOL_ORDER = [
  // (1) readonly: items → PRs → commits/CI
  "list_items",
  "get_item",
  "get_pull_request",
  "get_commit",
  "get_ci_status",
  // (2) links
  "find_related_pull_requests",
  // (3) memory readonly
  "list_memory",
  "get_memory",
  // (4) source readonly
  "list_sources",
  "get_source",
  "search_sources",
  // (5) MCP — populated dynamically; tool names depend on configured servers.
  // (6) mutating provider tools (stripped in read-only)
  "propose_transition",
  "propose_description_patch",
  "propose_comment",
  "propose_new_item",
  "propose_item_tags",
  // (7) memory mutations (stripped in read-only)
  "propose_memory_write",
  "propose_memory_delete",
  // out-of-band: ask_user_question (the loop dispatches it specially, but
  // we still expose the tool so the model can request it like any other)
  "ask_user_question",
  // (8) web_fetch — read-only network tool, gated by per-project
  // `web-fetch.enabled`. Pinned at the tail so toggling its presence
  // doesn't shift any earlier tool's position in the prompt cache key.
  "web_fetch",
  // (9) discovery — read-only tools added after the original cohort.
  // Appended at the tail so introducing them doesn't shift any earlier
  // tool's slot in the prompt cache key. All four are pure reads, so they
  // appear in both read-only and read-write modes.
  "search_items",
  "list_audit_log",
  "get_pull_request_diff",
  "search_code",
  "search_pull_requests",
] as const satisfies readonly string[];

export type RegisteredToolName = (typeof TOOL_ORDER)[number];

export async function buildToolRegistry(
  ctx: ToolContext,
  opts: ToolRegistryOptions = { readOnly: false },
): Promise<readonly AgentTool[]> {
  const tools: AgentTool[] = [];
  // (1)
  tools.push(...readonlyTools(ctx));
  // (2)
  tools.push(findRelatedPullRequestsTool(ctx));
  // (3)
  tools.push(...memoryReadonlyTools(ctx));
  // (4)
  tools.push(...sourceReadonlyTools(ctx));
  // (5) MCP — stripped in read-only (a remote MCP tool can mutate arbitrary
  // external state and we have no way to reason about whether a given
  // tool is read-only). Same risk model as provider mutating tools.
  if (!opts.readOnly) {
    tools.push(...(await mcpTools(ctx)));
  }
  // (6) — mutating provider tools
  if (!opts.readOnly) {
    tools.push(
      proposeTransitionTool(ctx),
      proposeDescriptionPatchTool(ctx),
      proposeCommentTool(ctx),
      proposeNewItemTool(ctx),
      proposeItemTagsTool(ctx),
    );
  }
  // (7) — memory mutations
  if (!opts.readOnly) {
    tools.push(proposeMemoryWriteTool(ctx), proposeMemoryDeleteTool(ctx));
  }
  // ask_user_question stays available in both modes; it never writes.
  tools.push(askUserQuestionTool(ctx));
  // (8) web_fetch — appears in both modes. Stripped when the project has
  // turned it off so the prompt prefix stays stable for projects that
  // never use it. The handler still re-checks the flag on every call,
  // so a flip mid-conversation is honored on the next turn.
  if (await loadProjectSetting(ctx.db, ctx.projectId, "web-fetch.enabled")) {
    tools.push(webFetchTool(ctx));
  }
  // (9) discovery — read-only, pinned at the tail. Always present.
  tools.push(...discoveryTools(ctx));
  return tools;
}
