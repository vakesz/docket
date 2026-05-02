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
import { and, arrayContains, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import type { ToolFactory } from "@/agent/tools/types";
import { defineTool, fail, ok } from "@/agent/tools/types";
import { sourceDocs } from "@/db/schema";

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
      const rows = await ctx.db
        .select({
          id: sourceDocs.id,
          title: sourceDocs.title,
          kind: sourceDocs.kind,
          uri: sourceDocs.uri,
          tags: sourceDocs.tags,
          updatedAt: sourceDocs.updatedAt,
        })
        .from(sourceDocs)
        .where(
          and(
            eq(sourceDocs.projectId, ctx.projectId),
            ...(args.kind ? [eq(sourceDocs.kind, args.kind)] : []),
            ...(args.tag ? [arrayContains(sourceDocs.tags, [args.tag])] : []),
          ),
        )
        .orderBy(desc(sourceDocs.updatedAt))
        .limit(args.limit);
      return ok(
        rows.map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.kind,
          uri: r.uri,
          tags: [...r.tags],
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
      const row = await ctx.db.query.sourceDocs.findFirst({
        where: and(eq(sourceDocs.id, sourceId), eq(sourceDocs.projectId, ctx.projectId)),
      });
      if (!row) return fail(`source '${sourceId}' not found in this project`);
      return ok({
        id: row.id,
        title: row.title,
        kind: row.kind,
        uri: row.uri,
        tags: [...row.tags],
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
      const pattern = `%${args.query}%`;
      const searchClause = or(ilike(sourceDocs.title, pattern), ilike(sourceDocs.body, pattern));
      const rows = await ctx.db
        .select({
          id: sourceDocs.id,
          title: sourceDocs.title,
          kind: sourceDocs.kind,
          uri: sourceDocs.uri,
          tags: sourceDocs.tags,
          updatedAt: sourceDocs.updatedAt,
        })
        .from(sourceDocs)
        .where(
          and(eq(sourceDocs.projectId, ctx.projectId), ...(searchClause ? [searchClause] : [])),
        )
        .orderBy(desc(sourceDocs.updatedAt))
        .limit(args.limit);
      return ok(
        rows.map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.kind,
          uri: r.uri,
          tags: [...r.tags],
          updated_at: r.updatedAt,
        })),
      );
    },
  });

export function sourceReadonlyTools(ctx: Parameters<ToolFactory>[0]) {
  return [listSourcesTool(ctx), getSourceTool(ctx), searchSourcesTool(ctx)] as const;
}
