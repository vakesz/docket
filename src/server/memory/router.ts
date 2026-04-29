/**
 * Memory API.
 *
 * Project memory entries are durable per-project facts the user (or the
 * agent through `propose_memory_write`) wants the assistant to remember.
 * Reads are direct DB queries. Writes and deletes go through the proposal
 * pipeline so the user sees a diff before anything lands — same shape as
 * the ticket-mutation flow.
 *
 * `proposeWrite` and `proposeDelete` return the staged proposal id; the UI
 * opens `<ProposalDialog>` with that id, which calls
 * `proposals.confirm` to execute and refresh.
 */

import "server-only";
import { z } from "zod";
import { proposeMemoryDelete, proposeMemoryWrite } from "@/server/proposals/builders";
import { maybeAutoAccept } from "@/server/proposals/executor";
import {
  assertFound,
  projectIdSchema,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  router,
} from "@/server/trpc";

const ListInput = projectIdSchema.extend({
  search: z.string().max(200).optional(),
  tag: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

const GetInput = projectIdSchema.extend({
  memoryId: z.string().min(1),
});

const ProposeWriteInput = projectIdSchema.extend({
  memoryId: z.string().min(1).nullable().default(null),
  title: z.string().min(1).max(200),
  bodyMd: z.string().max(50_000).default(""),
  tags: z.array(z.string().min(1).max(64)).max(32).default([]),
});

const ProposeDeleteInput = projectIdSchema.extend({
  memoryId: z.string().min(1),
});

export const memoryRouter = router({
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    return ctx.db.memoryEntry.findMany({
      where: {
        projectId: ctx.projectId,
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
      await ctx.db.memoryEntry.findFirst({
        where: { id: input.memoryId, projectId: ctx.projectId },
      }),
      "memory entry not found",
    );
  }),

  proposeWrite: projectScopedMutationProcedure
    .input(ProposeWriteInput)
    .mutation(async ({ ctx, input }) => {
      const c = {
        db: ctx.db,
        projectId: ctx.projectId,
        userId: ctx.userId,
        origin: "ui" as const,
      };
      const proposal = await maybeAutoAccept(
        c,
        await proposeMemoryWrite(c, {
          memoryId: input.memoryId,
          title: input.title,
          bodyMd: input.bodyMd,
          tags: input.tags,
          source: "user",
        }),
      );
      return { proposalId: proposal.id, kind: proposal.kind, status: proposal.status };
    }),

  proposeDelete: projectScopedMutationProcedure
    .input(ProposeDeleteInput)
    .mutation(async ({ ctx, input }) => {
      const c = {
        db: ctx.db,
        projectId: ctx.projectId,
        userId: ctx.userId,
        origin: "ui" as const,
      };
      const proposal = await maybeAutoAccept(
        c,
        await proposeMemoryDelete(c, { memoryId: input.memoryId }),
      );
      return { proposalId: proposal.id, kind: proposal.kind, status: proposal.status };
    }),
});
