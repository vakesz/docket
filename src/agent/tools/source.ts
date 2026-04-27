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
import { zodToJsonSchema } from "@/agent/tools/schema";
import type { ToolFactory } from "@/agent/tools/types";
import { fail, ok } from "@/agent/tools/types";

export const listSourcesTool: ToolFactory = (ctx) => ({
  def: {
    name: "list_sources",
    description:
      "List source documents in the current project. Filter by kind (e.g. 'requirements', 'runbook') or tag.",
    parameters: zodToJsonSchema(
      z.object({
        kind: z.string().optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    ),
  },
  handler: async (raw) => {
    const args = z
      .object({
        kind: z.string().optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(20),
      })
      .parse(raw);
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
    return ok(rows);
  },
});

export const readSourceTool: ToolFactory = (ctx) => ({
  def: {
    name: "read_source",
    description: "Read a source document by id. Returns full body markdown.",
    parameters: zodToJsonSchema(z.object({ sourceId: z.string().min(1) })),
  },
  handler: async (raw) => {
    const { sourceId } = z.object({ sourceId: z.string().min(1) }).parse(raw);
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
      bodyMd: row.bodyMd,
      updatedAt: row.updatedAt,
    });
  },
});

export const searchSourcesTool: ToolFactory = (ctx) => ({
  def: {
    name: "search_sources",
    description:
      "Free-text search across source documents in this project (title + body). Use this before read_source to locate the right doc.",
    parameters: zodToJsonSchema(
      z.object({
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(20).default(10),
      }),
    ),
  },
  handler: async (raw) => {
    const args = z
      .object({
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(20).default(10),
      })
      .parse(raw);
    const rows = await ctx.db.sourceDoc.findMany({
      where: {
        projectId: ctx.projectId,
        OR: [
          { title: { contains: args.query, mode: "insensitive" } },
          { bodyMd: { contains: args.query, mode: "insensitive" } },
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
    return ok(rows);
  },
});

export function sourceReadonlyTools(ctx: Parameters<ToolFactory>[0]) {
  return [listSourcesTool(ctx), readSourceTool(ctx), searchSourcesTool(ctx)] as const;
}
