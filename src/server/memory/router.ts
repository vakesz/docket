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
import { and, arrayContains, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { escapeLike } from "@/db/like";
import { memoryEntries } from "@/db/schema";
import { proposeMemoryDelete, proposeMemoryWrite } from "@/server/proposals/builders";
import { maybeAutoAccept } from "@/server/proposals/executor";
import {
  assertFound,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  projectSlugSchema,
  router,
} from "@/server/trpc";

const ListInput = projectSlugSchema.extend({
  search: z.string().max(200).optional(),
  tag: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

const GetInput = projectSlugSchema.extend({
  memoryId: z.string().min(1),
});

const ProposeWriteInput = projectSlugSchema.extend({
  memoryId: z.string().min(1).nullable().default(null),
  title: z.string().min(1).max(200),
  body: z.string().max(50_000).default(""),
  tags: z.array(z.string().min(1).max(64)).max(32).default([]),
});

const ProposeDeleteInput = projectSlugSchema.extend({
  memoryId: z.string().min(1),
});

export const memoryRouter = router({
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const conditions = [eq(memoryEntries.projectId, ctx.projectId)];
    if (input.tag) conditions.push(arrayContains(memoryEntries.tags, [input.tag]));
    if (input.search) {
      const needle = `%${escapeLike(input.search)}%`;
      const orClause = or(ilike(memoryEntries.title, needle), ilike(memoryEntries.body, needle));
      if (orClause) conditions.push(orClause);
    }
    return ctx.db.query.memoryEntries.findMany({
      where: and(...conditions),
      orderBy: [desc(memoryEntries.updatedAt)],
      limit: input.limit,
    });
  }),

  get: projectScopedProcedure.input(GetInput).query(async ({ ctx, input }) => {
    return assertFound(
      await ctx.db.query.memoryEntries.findFirst({
        where: and(
          eq(memoryEntries.id, input.memoryId),
          eq(memoryEntries.projectId, ctx.projectId),
        ),
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
          body: input.body,
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
