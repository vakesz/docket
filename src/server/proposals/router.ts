import "server-only";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ITEM_KINDS, type ProjectId, TRANSITION_INTENTS, type UserId } from "@/core/types";
import type { Db } from "@/db";
import { audits, proposals } from "@/db/schema";
import type { Proposal as ProposalRow } from "@/db/schema/types";
import { proposalIdSchema, providerItemIdSchema } from "@/lib/zod-ids";
import {
  hydrateProposal,
  proposeAssigneeChange,
  proposeComment,
  proposeDescriptionPatch,
  proposeNewItem,
  proposeReactionToggle,
  proposeTagsChange,
  proposeTransition,
} from "@/server/proposals/builders";
import { diffOf, isEmptyDiff } from "@/server/proposals/diff";
import { confirmProposal, maybeAutoAccept, rejectProposal } from "@/server/proposals/executor";
import {
  assertFound,
  projectScopedApproverProcedure,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  projectSlugSchema,
  router,
} from "@/server/trpc";

const ItemKindEnum = z.enum(ITEM_KINDS);
const TransitionIntentEnum = z.enum(TRANSITION_INTENTS);
const ReactionTargetKindEnum = z.enum(["item", "comment"]);
const ReactionOpEnum = z.enum(["add", "remove"]);
const ReactionKindSchema = z.string().min(1).max(64);

const ListInput = projectSlugSchema.extend({
  status: z.enum(["pending", "confirmed", "rejected", "all"]).default("pending"),
  limit: z.number().int().min(1).max(100).default(50),
});

const CountInput = projectSlugSchema.extend({
  status: z.enum(["pending", "confirmed", "rejected", "all"]).default("pending"),
});

const ProposalIdInput = projectSlugSchema.extend({
  proposalId: proposalIdSchema,
});

const AuditListInput = projectSlugSchema.extend({
  proposalId: proposalIdSchema.optional(),
  action: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const ProposeTransitionInput = projectSlugSchema.extend({
  providerItemId: providerItemIdSchema,
  intent: TransitionIntentEnum,
  canonicalItemId: providerItemIdSchema.optional(),
});

const ProposeDescriptionPatchInput = projectSlugSchema.extend({
  providerItemId: providerItemIdSchema,
  newDescription: z.string().max(50_000),
  includePreviousVersion: z.boolean().optional(),
});

const ProposeCommentInput = projectSlugSchema.extend({
  providerItemId: providerItemIdSchema,
  body: z.string().min(1).max(50_000),
});

const ProposeTagsChangeInput = projectSlugSchema.extend({
  providerItemId: providerItemIdSchema,
  nextTags: z.array(z.string().min(1).max(80)).max(50),
});

const ProposeAssigneeChangeInput = projectSlugSchema.extend({
  providerItemId: providerItemIdSchema,
  nextAssignee: z.string().max(200).nullable(),
});

const ProposeReactionToggleInput = projectSlugSchema.extend({
  providerItemId: providerItemIdSchema,
  targetKind: ReactionTargetKindEnum,
  targetId: z.string().min(1),
  reaction: ReactionKindSchema,
  op: ReactionOpEnum,
});

const ProposeNewItemInput = projectSlugSchema.extend({
  itemKind: ItemKindEnum,
  fields: z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(50_000).default(""),
    parentId: z.string().nullable().default(null),
    assignee: z.string().nullable().default(null),
    tags: z.array(z.string()).default([]),
  }),
});

type ProposalCtx = {
  db: Db;
  projectId: ProjectId;
  userId: UserId;
  origin: "ui";
};

function ctxFor(ctx: { db: Db; projectId: ProjectId; userId: UserId }): ProposalCtx {
  return { db: ctx.db, projectId: ctx.projectId, userId: ctx.userId, origin: "ui" };
}

/**
 * Stage a proposal via `build`, run it through the auto-accept gate, and
 * return the shape the UI expects (`{ id, status, diff }`). Every UI-
 * initiated propose endpoint reduces to one call to this helper, which
 * keeps the ctx-stamping + auto-accept + diff-rendering steps off each
 * route body.
 */
async function stageAndAccept(
  ctx: { db: Db; projectId: ProjectId; userId: UserId },
  build: (c: ProposalCtx) => Promise<ProposalRow>,
) {
  const c = ctxFor(ctx);
  const row = await maybeAutoAccept(c, await build(c));
  return { id: row.id, status: row.status, diff: diffOf(hydrateProposal(row)) };
}

export const proposalsRouter = router({
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const conditions = [eq(proposals.projectId, ctx.projectId)];
    if (input.status !== "all") conditions.push(eq(proposals.status, input.status));
    return ctx.db.query.proposals.findMany({
      where: and(...conditions),
      orderBy: [desc(proposals.createdAt)],
      limit: input.limit,
      columns: {
        id: true,
        kind: true,
        status: true,
        providerItemId: true,
        createdAt: true,
        confirmedAt: true,
        executedAt: true,
        errorMessage: true,
      },
    });
  }),

  count: projectScopedProcedure.input(CountInput).query(async ({ ctx, input }) => {
    const conditions = [eq(proposals.projectId, ctx.projectId)];
    if (input.status !== "all") conditions.push(eq(proposals.status, input.status));
    const rows = await ctx.db
      .select({ c: count() })
      .from(proposals)
      .where(and(...conditions));
    return rows[0]?.c ?? 0;
  }),

  get: projectScopedProcedure.input(ProposalIdInput).query(async ({ ctx, input }) => {
    const row = assertFound(
      await ctx.db.query.proposals.findFirst({
        where: and(eq(proposals.id, input.proposalId), eq(proposals.projectId, ctx.projectId)),
      }),
      "proposal not found",
    );
    const proposal = hydrateProposal(row);
    const diff = diffOf(proposal);
    return { row, diff, isEmpty: isEmptyDiff(diff) };
  }),

  proposeTransition: projectScopedMutationProcedure
    .input(ProposeTransitionInput)
    .mutation(({ ctx, input }) =>
      stageAndAccept(ctx, (c) =>
        proposeTransition(c, {
          providerItemId: input.providerItemId,
          intent: input.intent,
          ...(input.canonicalItemId ? { canonicalItemId: input.canonicalItemId } : {}),
        }),
      ),
    ),

  proposeDescriptionPatch: projectScopedMutationProcedure
    .input(ProposeDescriptionPatchInput)
    .mutation(({ ctx, input }) =>
      stageAndAccept(ctx, (c) =>
        proposeDescriptionPatch(c, {
          providerItemId: input.providerItemId,
          newDescription: input.newDescription,
          ...(input.includePreviousVersion !== undefined
            ? { includePreviousVersion: input.includePreviousVersion }
            : {}),
        }),
      ),
    ),

  proposeComment: projectScopedMutationProcedure
    .input(ProposeCommentInput)
    .mutation(({ ctx, input }) =>
      stageAndAccept(ctx, (c) =>
        proposeComment(c, { providerItemId: input.providerItemId, body: input.body }),
      ),
    ),

  proposeNewItem: projectScopedMutationProcedure
    .input(ProposeNewItemInput)
    .mutation(({ ctx, input }) =>
      stageAndAccept(ctx, (c) =>
        proposeNewItem(c, { itemKind: input.itemKind, fields: input.fields }),
      ),
    ),

  proposeTagsChange: projectScopedMutationProcedure
    .input(ProposeTagsChangeInput)
    .mutation(({ ctx, input }) =>
      stageAndAccept(ctx, (c) =>
        proposeTagsChange(c, {
          providerItemId: input.providerItemId,
          nextTags: input.nextTags,
        }),
      ),
    ),

  proposeAssigneeChange: projectScopedMutationProcedure
    .input(ProposeAssigneeChangeInput)
    .mutation(({ ctx, input }) =>
      stageAndAccept(ctx, (c) =>
        proposeAssigneeChange(c, {
          providerItemId: input.providerItemId,
          nextAssignee: input.nextAssignee,
        }),
      ),
    ),

  proposeReactionToggle: projectScopedMutationProcedure
    .input(ProposeReactionToggleInput)
    .mutation(({ ctx, input }) =>
      stageAndAccept(ctx, (c) =>
        proposeReactionToggle(c, {
          providerItemId: input.providerItemId,
          targetKind: input.targetKind,
          targetId: input.targetId,
          reaction: input.reaction,
          op: input.op,
        }),
      ),
    ),

  confirm: projectScopedApproverProcedure
    .input(ProposalIdInput)
    .mutation(async ({ ctx, input }) => {
      return confirmProposal(ctxFor(ctx), input.proposalId);
    }),

  reject: projectScopedApproverProcedure.input(ProposalIdInput).mutation(async ({ ctx, input }) => {
    return rejectProposal(ctxFor(ctx), input.proposalId);
  }),

  auditList: projectScopedProcedure.input(AuditListInput).query(async ({ ctx, input }) => {
    const conditions = [eq(audits.projectId, ctx.projectId)];
    if (input.proposalId) conditions.push(eq(audits.proposalId, input.proposalId));
    if (input.action) conditions.push(eq(audits.action, input.action));
    return ctx.db.query.audits.findMany({
      where: and(...conditions),
      orderBy: [desc(audits.createdAt)],
      limit: input.limit,
    });
  }),
});
