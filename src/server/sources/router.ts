/**
 * Sources API.
 *
 * Source documents are author material the assistant can cite from but is
 * never allowed to edit (AGENTS.md rule 6). All writes are human-driven
 * through this router — there is intentionally no proposal pipeline here:
 * the agent's mutating-tool registry deliberately does not include a
 * `propose_source_*` family, and the architecture test
 * `src/__arch__/no-source-mutation-tools.test.ts` enforces that.
 *
 * Storage shape: `body: String`. Sources are text-only today (paste or
 * `.md`/`.txt` upload); a `Source.body bytea` column is reserved for binary
 * uploads if/when we need them.
 */

import "server-only";
import { TRPCError } from "@trpc/server";
import { and, arrayContains, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { escapeLike } from "@/db/like";
import { sourceDocs } from "@/db/schema";
import {
  assertFound,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  projectSlugSchema,
  router,
} from "@/server/trpc";

const ListInput = projectSlugSchema.extend({
  kind: z.string().max(64).optional(),
  tag: z.string().max(64).optional(),
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

const GetInput = projectSlugSchema.extend({
  sourceId: z.string().min(1),
});

const CreateInput = projectSlugSchema.extend({
  title: z.string().min(1).max(200),
  kind: z.string().max(64).default(""),
  uri: z.string().max(500).default(""),
  body: z.string().max(500_000).default(""),
  tags: z.array(z.string().min(1).max(64)).max(32).default([]),
});

const UpdateInput = GetInput.extend({
  title: z.string().min(1).max(200).optional(),
  kind: z.string().max(64).optional(),
  uri: z.string().max(500).optional(),
  body: z.string().max(500_000).optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
});

export const sourcesRouter = router({
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const conditions = [eq(sourceDocs.projectId, ctx.projectId)];
    if (input.kind) conditions.push(eq(sourceDocs.kind, input.kind));
    if (input.tag) conditions.push(arrayContains(sourceDocs.tags, [input.tag]));
    if (input.search) {
      const needle = `%${escapeLike(input.search)}%`;
      const orClause = or(ilike(sourceDocs.title, needle), ilike(sourceDocs.body, needle));
      if (orClause) conditions.push(orClause);
    }
    return ctx.db.query.sourceDocs.findMany({
      where: and(...conditions),
      orderBy: [desc(sourceDocs.updatedAt)],
      limit: input.limit,
    });
  }),

  get: projectScopedProcedure.input(GetInput).query(async ({ ctx, input }) => {
    return assertFound(
      await ctx.db.query.sourceDocs.findFirst({
        where: and(eq(sourceDocs.id, input.sourceId), eq(sourceDocs.projectId, ctx.projectId)),
      }),
      "source not found",
    );
  }),

  create: projectScopedMutationProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .insert(sourceDocs)
      .values({
        projectId: ctx.projectId,
        title: input.title.trim(),
        kind: input.kind,
        uri: input.uri,
        body: input.body,
        tags: input.tags,
      })
      .returning();
    if (!row) throw new Error("source create returned no row");
    return row;
  }),

  update: projectScopedMutationProcedure.input(UpdateInput).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .update(sourceDocs)
      .set({
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.uri !== undefined ? { uri: input.uri } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      })
      .where(and(eq(sourceDocs.id, input.sourceId), eq(sourceDocs.projectId, ctx.projectId)))
      .returning();
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "source not found" });
    }
    return row;
  }),

  delete: projectScopedMutationProcedure.input(GetInput).mutation(async ({ ctx, input }) => {
    const deleted = await ctx.db
      .delete(sourceDocs)
      .where(and(eq(sourceDocs.id, input.sourceId), eq(sourceDocs.projectId, ctx.projectId)))
      .returning({ id: sourceDocs.id });
    if (deleted.length === 0) {
      throw new TRPCError({ code: "NOT_FOUND", message: "source not found" });
    }
    return { id: input.sourceId };
  }),
});
