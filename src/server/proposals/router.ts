import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ITEM_KINDS, TRANSITION_INTENTS } from "@/core/types";
import {
  hydrateProposal,
  proposeComment,
  proposeDescriptionPatch,
  proposeNewItem,
  proposeTransition,
} from "@/server/proposals/builders";
import { diffOf } from "@/server/proposals/diff";
import { confirmProposal, rejectProposal } from "@/server/proposals/executor";
import { projectScopedMutationProcedure, projectScopedProcedure, router } from "@/server/trpc";

const ProjectId = z.object({ projectId: z.string().min(1) });

const ItemKindEnum = z.enum(ITEM_KINDS);
const TransitionIntentEnum = z.enum(TRANSITION_INTENTS);

const ListInput = ProjectId.extend({
  status: z.enum(["pending", "confirmed", "rejected", "all"]).default("pending"),
  limit: z.number().int().min(1).max(100).default(50),
});

const ProposalIdInput = ProjectId.extend({ proposalId: z.string().min(1) });

const ProposeTransitionInput = ProjectId.extend({
  providerItemId: z.string().min(1),
  intent: TransitionIntentEnum,
});

const ProposeDescriptionPatchInput = ProjectId.extend({
  providerItemId: z.string().min(1),
  newMd: z.string().max(50_000),
});

const ProposeCommentInput = ProjectId.extend({
  providerItemId: z.string().min(1),
  bodyMd: z.string().min(1).max(50_000),
});

const ProposeNewItemInput = ProjectId.extend({
  itemKind: ItemKindEnum,
  fields: z.object({
    title: z.string().min(1).max(500),
    descriptionMd: z.string().max(50_000).default(""),
    parentId: z.string().nullable().default(null),
    assignee: z.string().nullable().default(null),
    tags: z.array(z.string()).default([]),
  }),
});

function ctxFor(ctx: {
  db: typeof import("@/server/db").db;
  projectId: string;
  session: { user: { id?: string } };
}) {
  const userId = ctx.session.user.id;
  if (!userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return { db: ctx.db, projectId: ctx.projectId, userId };
}

/**
 * Proposals API (Phase 4).
 *
 * Reads (`list`, `get`) live on `projectScopedProcedure` so viewers can see
 * what the team is staging. Stages (`propose*`) and `confirm`/`reject` use
 * `projectScopedMutationProcedure`, which rejects 'viewer' members.
 *
 * `get` returns the persisted row plus a freshly computed `diff`. The diff
 * isn't stored — it's derived from the payload at read time so updates to
 * the diff renderer apply retroactively to in-flight proposals.
 */
export const proposalsRouter = router({
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const rows = await ctx.db.proposal.findMany({
      where: {
        projectId: ctx.projectId,
        ...(input.status === "all" ? {} : { status: input.status }),
      },
      orderBy: [{ createdAt: "desc" }],
      take: input.limit,
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      providerItemId: row.providerItemId,
      createdAt: row.createdAt,
      confirmedAt: row.confirmedAt,
      executedAt: row.executedAt,
      errorMessage: row.errorMessage,
    }));
  }),

  get: projectScopedProcedure.input(ProposalIdInput).query(async ({ ctx, input }) => {
    const row = await ctx.db.proposal.findFirst({
      where: { id: input.proposalId, projectId: ctx.projectId },
    });
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "proposal not found" });
    }
    const proposal = hydrateProposal(row);
    return { row, diff: diffOf(proposal) };
  }),

  proposeTransition: projectScopedMutationProcedure
    .input(ProposeTransitionInput)
    .mutation(async ({ ctx, input }) => {
      const row = await proposeTransition(ctxFor(ctx), {
        providerItemId: input.providerItemId,
        intent: input.intent,
      });
      return { id: row.id, diff: diffOf(hydrateProposal(row)) };
    }),

  proposeDescriptionPatch: projectScopedMutationProcedure
    .input(ProposeDescriptionPatchInput)
    .mutation(async ({ ctx, input }) => {
      const row = await proposeDescriptionPatch(ctxFor(ctx), {
        providerItemId: input.providerItemId,
        newMd: input.newMd,
      });
      return { id: row.id, diff: diffOf(hydrateProposal(row)) };
    }),

  proposeComment: projectScopedMutationProcedure
    .input(ProposeCommentInput)
    .mutation(async ({ ctx, input }) => {
      const row = await proposeComment(ctxFor(ctx), {
        providerItemId: input.providerItemId,
        bodyMd: input.bodyMd,
      });
      return { id: row.id, diff: diffOf(hydrateProposal(row)) };
    }),

  proposeNewItem: projectScopedMutationProcedure
    .input(ProposeNewItemInput)
    .mutation(async ({ ctx, input }) => {
      const row = await proposeNewItem(ctxFor(ctx), {
        itemKind: input.itemKind,
        fields: input.fields,
      });
      return { id: row.id, diff: diffOf(hydrateProposal(row)) };
    }),

  confirm: projectScopedMutationProcedure
    .input(ProposalIdInput)
    .mutation(async ({ ctx, input }) => {
      return confirmProposal(ctxFor(ctx), input.proposalId);
    }),

  reject: projectScopedMutationProcedure.input(ProposalIdInput).mutation(async ({ ctx, input }) => {
    return rejectProposal(ctxFor(ctx), input.proposalId);
  }),
});
