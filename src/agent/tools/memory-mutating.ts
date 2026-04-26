/**
 * Memory mutating tools — stage memory_write / memory_delete proposals.
 *
 * Same pattern as `mutating.ts` (provider writes): the agent never touches
 * the `memoryEntry` table directly. It builds a Proposal, the human sees a
 * diff in `<ProposalDialog>`, and only on confirm does
 * `confirmProposal` perform the upsert / delete.
 *
 * In read-only mode the tool registry strips this entire group. The handlers
 * themselves don't gate on role: by the time we get here the registry has
 * already decided whether to expose them. This is registry slot 7 in the
 * pinned order — separate from provider mutations (slot 6) so a future
 * "writes are allowed but provider is offline" mode could expose memory
 * writes without provider writes.
 */

import "server-only";
import { z } from "zod";
import { zodToJsonSchema } from "@/agent/tools/schema";
import type { ToolFactory } from "@/agent/tools/types";
import { fail, ok } from "@/agent/tools/types";
import { proposeMemoryDelete, proposeMemoryWrite } from "@/server/proposals/builders";

function builderCtx(ctx: Parameters<ToolFactory>[0]) {
  return { db: ctx.db, projectId: ctx.projectId, userId: ctx.userId };
}

export const proposeMemoryWriteTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_memory_write",
    description:
      "Stage a project-memory entry (create or update). If memoryId is null a new entry is staged; otherwise the named entry is overwritten. The human reviews the diff and confirms before anything lands.",
    parameters: zodToJsonSchema(
      z.object({
        memoryId: z.string().nullable().default(null),
        title: z.string().min(1).max(200),
        bodyMd: z.string().max(50_000).default(""),
        tags: z.array(z.string().min(1).max(64)).max(32).default([]),
      }),
    ),
  },
  handler: async (raw) => {
    const args = z
      .object({
        memoryId: z.string().nullable().default(null),
        title: z.string().min(1).max(200),
        bodyMd: z.string().max(50_000).default(""),
        tags: z.array(z.string().min(1).max(64)).max(32).default([]),
      })
      .parse(raw);
    try {
      const row = await proposeMemoryWrite(builderCtx(ctx), {
        memoryId: args.memoryId,
        title: args.title,
        bodyMd: args.bodyMd,
        tags: args.tags,
        source: "agent",
      });
      return ok({ proposalId: row.id, kind: row.kind });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const proposeMemoryDeleteTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_memory_delete",
    description: "Stage deletion of a project-memory entry. The human confirms before delete.",
    parameters: zodToJsonSchema(z.object({ memoryId: z.string().min(1) })),
  },
  handler: async (raw) => {
    const { memoryId } = z.object({ memoryId: z.string().min(1) }).parse(raw);
    try {
      const row = await proposeMemoryDelete(builderCtx(ctx), { memoryId });
      return ok({ proposalId: row.id, kind: row.kind });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export function memoryMutatingTools(ctx: Parameters<ToolFactory>[0]) {
  return [proposeMemoryWriteTool(ctx), proposeMemoryDeleteTool(ctx)] as const;
}
