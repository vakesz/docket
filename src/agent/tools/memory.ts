/**
 * Memory tools — readonly half.
 *
 * Memory entries are per-project key facts the user has saved by hand or
 * staged through `propose_memory_write`. The agent surfaces them on
 * demand rather than baking them into the prompt prefix — that keeps the
 * prefix byte-stable (AGENTS.md "Keep the prompt prefix byte-stable")
 * while still making the facts reachable.
 *
 * Mutations (memory_write / memory_delete) live in `memory-mutating.ts` —
 * a separate registry slot so a future "memory writes allowed but provider
 * is offline" mode could expose them independently of the provider mutating
 * group. The pinned tool order keeps both groups discoverable.
 */

import "server-only";
import { and, arrayContains, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import type { ToolFactory } from "@/agent/tools/types";
import { defineTool, fail, ok } from "@/agent/tools/types";
import { escapeLike } from "@/db/like";
import { memoryEntries } from "@/db/schema";

export const listMemoryTool: ToolFactory = (ctx) =>
  defineTool({
    name: "list_memory",
    description:
      "List memory entries saved for the current project. Filter by tag or free-text search across title + body.",
    schema: z.object({
      tag: z.string().optional().describe("Restrict to entries carrying this tag."),
      search: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    // List view returns id/title/tags/source/updatedAt — only the title is
    // user-authored. Body markdown is fetched separately via get_memory.
    guardrailScan: { mode: "fields", untrusted: ["[].title"] },
    handler: async (args) => {
      const searchPattern = args.search ? `%${escapeLike(args.search)}%` : null;
      const searchClause = searchPattern
        ? or(ilike(memoryEntries.title, searchPattern), ilike(memoryEntries.body, searchPattern))
        : undefined;
      const rows = await ctx.db
        .select({
          id: memoryEntries.id,
          title: memoryEntries.title,
          tags: memoryEntries.tags,
          source: memoryEntries.source,
          updatedAt: memoryEntries.updatedAt,
        })
        .from(memoryEntries)
        .where(
          and(
            eq(memoryEntries.projectId, ctx.projectId),
            ...(args.tag ? [arrayContains(memoryEntries.tags, [args.tag])] : []),
            ...(searchClause ? [searchClause] : []),
          ),
        )
        .orderBy(desc(memoryEntries.updatedAt))
        .limit(args.limit);
      return ok(
        rows.map((r) => ({
          id: r.id,
          title: r.title,
          tags: [...r.tags],
          source: r.source,
          updated_at: r.updatedAt,
        })),
      );
    },
  });

export const getMemoryTool: ToolFactory = (ctx) =>
  defineTool({
    name: "get_memory",
    description: "Read one memory entry by id. Returns full markdown body.",
    schema: z.object({ memory_id: z.string().min(1) }),
    // Title and body are user-authored. id/tags/source/updated_at are
    // server-controlled metadata.
    guardrailScan: { mode: "fields", untrusted: ["title", "body"] },
    handler: async ({ memory_id: memoryId }) => {
      const row = await ctx.db.query.memoryEntries.findFirst({
        where: and(eq(memoryEntries.id, memoryId), eq(memoryEntries.projectId, ctx.projectId)),
      });
      if (!row) return fail(`memory entry '${memoryId}' not found in this project`);
      return ok({
        id: row.id,
        title: row.title,
        body: row.body,
        tags: [...row.tags],
        source: row.source,
        updated_at: row.updatedAt,
      });
    },
  });

export function memoryReadonlyTools(ctx: Parameters<ToolFactory>[0]) {
  return [listMemoryTool(ctx), getMemoryTool(ctx)] as const;
}
