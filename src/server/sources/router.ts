/**
 * Sources API (Phase 7).
 *
 * Source documents are author material the assistant can cite from but is
 * never allowed to edit (CLAUDE.md rule 6). All writes are human-driven
 * through this router — there is intentionally no proposal pipeline here:
 * the agent's mutating-tool registry deliberately does not include a
 * `propose_source_*` family, and the architecture test
 * `src/__arch__/no-source-mutation-tools.test.ts` enforces that.
 *
 * Storage shape: `bodyMd: String`. Phase 7 keeps sources text-only (paste
 * or `.md`/`.txt` upload). The migration sketch reserves `Source.body bytea`
 * for binary uploads if/when we need them; that lands in a later phase
 * alongside text extraction.
 */

import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { projectScopedMutationProcedure, projectScopedProcedure, router } from "@/server/trpc";

const ProjectId = z.object({ projectId: z.string().min(1) });

const ListInput = ProjectId.extend({
  kind: z.string().max(64).optional(),
  tag: z.string().max(64).optional(),
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

const GetInput = ProjectId.extend({
  sourceId: z.string().min(1),
});

const CreateInput = ProjectId.extend({
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
    const row = await ctx.db.sourceDoc.findFirst({
      where: { id: input.sourceId, projectId: ctx.projectId },
    });
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "source not found" });
    }
    return row;
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
    const existing = await ctx.db.sourceDoc.findFirst({
      where: { id: input.sourceId, projectId: ctx.projectId },
    });
    if (!existing) {
      throw new TRPCError({ code: "NOT_FOUND", message: "source not found" });
    }
    return ctx.db.sourceDoc.update({
      where: { id: existing.id },
      data: {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.uri !== undefined ? { uri: input.uri } : {}),
        ...(input.bodyMd !== undefined ? { bodyMd: input.bodyMd } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      },
    });
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
