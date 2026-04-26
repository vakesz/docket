/**
 * Memory tools — readonly half.
 *
 * Memory entries are per-project key facts the user has saved by hand or
 * staged through `propose_memory_write`. The agent surfaces them on
 * demand rather than baking them into the prompt prefix — that keeps the
 * prefix byte-stable (CLAUDE.md invariant 7) while still making the
 * facts reachable.
 *
 * Mutations (memory_write / memory_delete) live in `memory-mutating.ts` —
 * a separate registry slot so a future "memory writes allowed but provider
 * is offline" mode could expose them independently of the provider mutating
 * group. The pinned tool order keeps both groups discoverable.
 */

import "server-only";
import { z } from "zod";
import { zodToJsonSchema } from "@/agent/tools/schema";
import type { ToolFactory } from "@/agent/tools/types";
import { fail, ok } from "@/agent/tools/types";

export const listMemoryTool: ToolFactory = (ctx) => ({
  def: {
    name: "list_memory",
    description:
      "List memory entries saved for the current project. Filter by tag or free-text search across title + body.",
    parameters: zodToJsonSchema(
      z.object({
        tag: z.string().optional().describe("Restrict to entries carrying this tag."),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    ),
  },
  handler: async (raw) => {
    const args = z
      .object({
        tag: z.string().optional(),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      })
      .parse(raw);
    const rows = await ctx.db.memoryEntry.findMany({
      where: {
        projectId: ctx.projectId,
        ...(args.tag ? { tags: { has: args.tag } } : {}),
        ...(args.search
          ? {
              OR: [
                { title: { contains: args.search, mode: "insensitive" } },
                { bodyMd: { contains: args.search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: "desc" }],
      take: args.limit,
      select: {
        id: true,
        title: true,
        tags: true,
        source: true,
        updatedAt: true,
      },
    });
    return ok(rows);
  },
});

export const getMemoryTool: ToolFactory = (ctx) => ({
  def: {
    name: "get_memory",
    description: "Read one memory entry by id. Returns full body markdown.",
    parameters: zodToJsonSchema(z.object({ memoryId: z.string().min(1) })),
  },
  handler: async (raw) => {
    const { memoryId } = z.object({ memoryId: z.string().min(1) }).parse(raw);
    const row = await ctx.db.memoryEntry.findFirst({
      where: { id: memoryId, projectId: ctx.projectId },
    });
    if (!row) return fail(`memory entry '${memoryId}' not found in this project`);
    return ok({
      id: row.id,
      title: row.title,
      bodyMd: row.bodyMd,
      tags: row.tags,
      source: row.source,
      updatedAt: row.updatedAt,
    });
  },
});

export function memoryReadonlyTools(ctx: Parameters<ToolFactory>[0]) {
  return [listMemoryTool(ctx), getMemoryTool(ctx)] as const;
}
