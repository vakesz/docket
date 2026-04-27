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
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { proposeMemoryDelete, proposeMemoryWrite } from "@/server/proposals/builders";
import { projectScopedMutationProcedure, projectScopedProcedure, router } from "@/server/trpc";

const ProjectId = z.object({ projectId: z.string().min(1) });

const ListInput = ProjectId.extend({
  search: z.string().max(200).optional(),
  tag: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

const GetInput = ProjectId.extend({
  memoryId: z.string().min(1),
});

const ProposeWriteInput = ProjectId.extend({
  memoryId: z.string().min(1).nullable().default(null),
  title: z.string().min(1).max(200),
  bodyMd: z.string().max(50_000).default(""),
  tags: z.array(z.string().min(1).max(64)).max(32).default([]),
});

const ProposeDeleteInput = ProjectId.extend({
  memoryId: z.string().min(1),
});

function userIdOrThrow(ctx: { session: { user: { id?: string } } }): string {
  const userId = ctx.session.user.id;
  if (!userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return userId;
}

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
    const row = await ctx.db.memoryEntry.findFirst({
      where: { id: input.memoryId, projectId: ctx.projectId },
    });
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "memory entry not found" });
    }
    return row;
  }),

  proposeWrite: projectScopedMutationProcedure
    .input(ProposeWriteInput)
    .mutation(async ({ ctx, input }) => {
      const proposal = await proposeMemoryWrite(
        { db: ctx.db, projectId: ctx.projectId, userId: userIdOrThrow(ctx) },
        {
          memoryId: input.memoryId,
          title: input.title,
          bodyMd: input.bodyMd,
          tags: input.tags,
          source: "user",
        },
      );
      return { proposalId: proposal.id, kind: proposal.kind };
    }),

  proposeDelete: projectScopedMutationProcedure
    .input(ProposeDeleteInput)
    .mutation(async ({ ctx, input }) => {
      const proposal = await proposeMemoryDelete(
        { db: ctx.db, projectId: ctx.projectId, userId: userIdOrThrow(ctx) },
        { memoryId: input.memoryId },
      );
      return { proposalId: proposal.id, kind: proposal.kind };
    }),
});
