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
 * Storage shape: `bodyMd: String`. Sources are text-only today (paste or
 * `.md`/`.txt` upload); a `Source.body bytea` column is reserved for binary
 * uploads if/when we need them.
 */

import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
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
  bodyMd: z.string().max(500_000).default(""),
  tags: z.array(z.string().min(1).max(64)).max(32).default([]),
});

const UpdateInput = GetInput.extend({
  title: z.string().min(1).max(200).optional(),
  kind: z.string().max(64).optional(),
  uri: z.string().max(500).optional(),
  bodyMd: z.string().max(500_000).optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
});

export const sourcesRouter = router({
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    return ctx.db.sourceDoc.findMany({
      where: {
        projectId: ctx.projectId,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.tag ? { tags: { has: input.tag } } : {}),
        ...(input.search
          ? {
              OR: [
                { title: { contains: input.search, mode: "insensitive" } },
                { bodyMd: { contains: input.search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: "desc" }],
      take: input.limit,
    });
  }),

  get: projectScopedProcedure.input(GetInput).query(async ({ ctx, input }) => {
    return assertFound(
      await ctx.db.sourceDoc.findFirst({
        where: { id: input.sourceId, projectId: ctx.projectId },
      }),
      "source not found",
    );
  }),

  create: projectScopedMutationProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    return ctx.db.sourceDoc.create({
      data: {
        projectId: ctx.projectId,
        title: input.title.trim(),
        kind: input.kind,
        uri: input.uri,
        bodyMd: input.bodyMd,
        tags: input.tags,
      },
    });
  }),

  update: projectScopedMutationProcedure.input(UpdateInput).mutation(async ({ ctx, input }) => {
    // updateMany scopes the update to (id, projectId) atomically — no need
    // for a pre-flight findFirst. count === 0 means either the row doesn't
    // exist or it belongs to a different project, which both surface as 404.
    const result = await ctx.db.sourceDoc.updateMany({
      where: { id: input.sourceId, projectId: ctx.projectId },
      data: {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.uri !== undefined ? { uri: input.uri } : {}),
        ...(input.bodyMd !== undefined ? { bodyMd: input.bodyMd } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      },
    });
    if (result.count === 0) {
      throw new TRPCError({ code: "NOT_FOUND", message: "source not found" });
    }
    return ctx.db.sourceDoc.findUniqueOrThrow({ where: { id: input.sourceId } });
  }),

  delete: projectScopedMutationProcedure.input(GetInput).mutation(async ({ ctx, input }) => {
    const result = await ctx.db.sourceDoc.deleteMany({
      where: { id: input.sourceId, projectId: ctx.projectId },
    });
    if (result.count === 0) {
      throw new TRPCError({ code: "NOT_FOUND", message: "source not found" });
    }
    return { id: input.sourceId };
  }),
});
