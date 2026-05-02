/**
 * Source-document tools — readonly only, by hard rule.
 *
 * Project sources (requirements docs, design notes, runbooks) are author
 * material the agent should be able to cite from but never edit. The
 * agent gets `list_sources` / `read_source` / `search_sources` only;
 * AGENTS.md rule 6 (and the arch test `no-source-mutation-tools`) keep
 * source writes off the agent surface.
 */

import "server-only";
import { z } from "zod";
import type { ToolFactory } from "@/agent/tools/types";
import { defineTool, fail, ok } from "@/agent/tools/types";

export const listSourcesTool: ToolFactory = (ctx) =>
  defineTool({
    name: "list_sources",
    description:
      "List source documents in the current project. Filter by kind (e.g. 'requirements', 'runbook') or tag.",
    schema: z.object({
      kind: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    // List view returns id/title/kind/uri/tags/updated_at — only the title
    // is author-controlled prose. Body markdown is fetched separately.
    guardrailScan: { mode: "fields", untrusted: ["[].title"] },
    handler: async (args) => {
      const rows = await ctx.db.sourceDoc.findMany({
        where: {
          projectId: ctx.projectId,
          ...(args.kind ? { kind: args.kind } : {}),
          ...(args.tag ? { tags: { has: args.tag } } : {}),
        },
        orderBy: [{ updatedAt: "desc" }],
        take: args.limit,
        select: {
          id: true,
          title: true,
          kind: true,
          uri: true,
          tags: true,
          updatedAt: true,
        },
      });
      return ok(
        rows.map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.kind,
          uri: r.uri,
          tags: r.tags,
          updated_at: r.updatedAt,
        })),
      );
    },
  });

export const getSourceTool: ToolFactory = (ctx) =>
  defineTool({
    name: "get_source",
    description: "Read a source document by id. Returns full markdown body.",
    schema: z.object({ source_id: z.string().min(1) }),
    // Title and body are author-authored markdown. The rest of the envelope
    // (id/kind/uri/tags/updated_at) is server / project metadata.
    guardrailScan: { mode: "fields", untrusted: ["title", "body"] },
    handler: async ({ source_id: sourceId }) => {
      const row = await ctx.db.sourceDoc.findFirst({
        where: { id: sourceId, projectId: ctx.projectId },
      });
      if (!row) return fail(`source '${sourceId}' not found in this project`);
      return ok({
        id: row.id,
        title: row.title,
        kind: row.kind,
        uri: row.uri,
        tags: row.tags,
        body: row.body,
        updated_at: row.updatedAt,
      });
    },
  });

export const searchSourcesTool: ToolFactory = (ctx) =>
  defineTool({
    name: "search_sources",
    description:
      "Free-text search across source documents in this project (title + body). Use this before get_source to locate the right doc.",
    schema: z.object({
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    // Same shape as list_sources — title is the only author-authored field.
    guardrailScan: { mode: "fields", untrusted: ["[].title"] },
    handler: async (args) => {
      const rows = await ctx.db.sourceDoc.findMany({
        where: {
          projectId: ctx.projectId,
          OR: [
            { title: { contains: args.query, mode: "insensitive" } },
            { body: { contains: args.query, mode: "insensitive" } },
          ],
        },
        orderBy: [{ updatedAt: "desc" }],
        take: args.limit,
        select: {
          id: true,
          title: true,
          kind: true,
          uri: true,
          tags: true,
          updatedAt: true,
        },
      });
      return ok(
        rows.map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.kind,
          uri: r.uri,
          tags: r.tags,
          updated_at: r.updatedAt,
        })),
      );
    },
  });

export function sourceReadonlyTools(ctx: Parameters<ToolFactory>[0]) {
  return [listSourcesTool(ctx), getSourceTool(ctx), searchSourcesTool(ctx)] as const;
}
