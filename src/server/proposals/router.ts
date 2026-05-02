import "server-only";
import { z } from "zod";
import {
  asProposalId,
  ITEM_KINDS,
  type ProjectId,
  TRANSITION_INTENTS,
  type UserId,
} from "@/core/types";
import type { Proposal as ProposalRow } from "@/db/generated/client";
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
// Reaction kinds are provider-declared (capabilities.supportedReactions); the
// router takes any opaque non-empty string and the provider validates against
// its own list inside addReaction/removeReaction. 64 is comfortably above
// every real-world reaction shortcode.
const ReactionKindSchema = z.string().min(1).max(64);

const ListInput = projectSlugSchema.extend({
  status: z.enum(["pending", "confirmed", "rejected", "all"]).default("pending"),
  limit: z.number().int().min(1).max(100).default(50),
});

const CountInput = projectSlugSchema.extend({
  status: z.enum(["pending", "confirmed", "rejected", "all"]).default("pending"),
});

const ProposalIdInput = projectSlugSchema.extend({ proposalId: z.string().min(1) });

const AuditListInput = projectSlugSchema.extend({
  /// When set, returns only audit rows for one proposal.
  proposalId: z.string().min(1).optional(),
  /// When set, filters to one action kind (e.g. `proposal.confirm.failed`).
  action: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const ProposeTransitionInput = projectSlugSchema.extend({
  providerItemId: z.string().min(1),
  intent: TransitionIntentEnum,
  canonicalItemId: z.string().min(1).optional(),
});

const ProposeDescriptionPatchInput = projectSlugSchema.extend({
  providerItemId: z.string().min(1),
  newDescription: z.string().max(50_000),
  includePreviousVersion: z.boolean().optional(),
});

const ProposeCommentInput = projectSlugSchema.extend({
  providerItemId: z.string().min(1),
  body: z.string().min(1).max(50_000),
});

const ProposeTagsChangeInput = projectSlugSchema.extend({
  providerItemId: z.string().min(1),
  nextTags: z.array(z.string().min(1).max(80)).max(50),
});

const ProposeAssigneeChangeInput = projectSlugSchema.extend({
  providerItemId: z.string().min(1),
  nextAssignee: z.string().max(200).nullable(),
});

const ProposeReactionToggleInput = projectSlugSchema.extend({
  providerItemId: z.string().min(1),
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
  db: typeof import("@/server/db").db;
  projectId: ProjectId;
  userId: UserId;
  origin: "ui";
};

function ctxFor(ctx: {
  db: typeof import("@/server/db").db;
  projectId: ProjectId;
  userId: UserId;
}): ProposalCtx {
  return { db: ctx.db, projectId: ctx.projectId, userId: ctx.userId, origin: "ui" };
}

/**
 * Run a builder, route through `maybeAutoAccept`, and shape the response
 * the UI expects. Every `propose*` mutation collapses to one call.
 */
async function stageAndAccept(c: ProposalCtx, builderResult: Promise<ProposalRow>) {
  const row = await maybeAutoAccept(c, await builderResult);
  return { id: row.id, status: row.status, diff: diffOf(hydrateProposal(row)) };
}

/**
 * Proposals API.
 *
 * - Reads (`list`, `get`) live on `projectScopedProcedure` so viewers can see
 *   what the team is staging.
 * - Stages (`propose*`) use `projectScopedMutationProcedure`, which rejects
 *   `viewer` members and blocks when the system is in read-only mode.
 * - `confirm`/`reject` use `projectScopedApproverProcedure`, which further
 *   restricts execution to project owners and members with role `approver`
 *   (the human-in-the-loop gate on writes).
 *
 * `get` returns the persisted row plus a freshly computed `diff`. The diff
 * isn't stored — it's derived from the payload at read time so updates to
 * the diff renderer apply retroactively to in-flight proposals.
 */
export const proposalsRouter = router({
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    // Explicit select keeps the `payload` JSON blob (the full proposed
    // change body) off the wire — list rows render summaries only.
    return ctx.db.proposal.findMany({
      where: {
        projectId: ctx.projectId,
        ...(input.status === "all" ? {} : { status: input.status }),
      },
      orderBy: [{ createdAt: "desc" }],
      take: input.limit,
      select: {
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

  count: projectScopedProcedure.input(CountInput).query(({ ctx, input }) => {
    return ctx.db.proposal.count({
      where: {
        projectId: ctx.projectId,
        ...(input.status === "all" ? {} : { status: input.status }),
      },
    });
  }),

  get: projectScopedProcedure.input(ProposalIdInput).query(async ({ ctx, input }) => {
    const row = assertFound(
      await ctx.db.proposal.findFirst({
        where: { id: input.proposalId, projectId: ctx.projectId },
      }),
      "proposal not found",
    );
    const proposal = hydrateProposal(row);
    const diff = diffOf(proposal);
    return { row, diff, isEmpty: isEmptyDiff(diff) };
  }),

  proposeTransition: projectScopedMutationProcedure
    .input(ProposeTransitionInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctxFor(ctx);
      return stageAndAccept(
        c,
        proposeTransition(c, {
          providerItemId: input.providerItemId,
          intent: input.intent,
          ...(input.canonicalItemId ? { canonicalItemId: input.canonicalItemId } : {}),
        }),
      );
    }),

  proposeDescriptionPatch: projectScopedMutationProcedure
    .input(ProposeDescriptionPatchInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctxFor(ctx);
      return stageAndAccept(
        c,
        proposeDescriptionPatch(c, {
          providerItemId: input.providerItemId,
          newDescription: input.newDescription,
          ...(input.includePreviousVersion !== undefined
            ? { includePreviousVersion: input.includePreviousVersion }
            : {}),
        }),
      );
    }),

  proposeComment: projectScopedMutationProcedure
    .input(ProposeCommentInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctxFor(ctx);
      return stageAndAccept(
        c,
        proposeComment(c, { providerItemId: input.providerItemId, body: input.body }),
      );
    }),

  proposeNewItem: projectScopedMutationProcedure
    .input(ProposeNewItemInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctxFor(ctx);
      return stageAndAccept(
        c,
        proposeNewItem(c, { itemKind: input.itemKind, fields: input.fields }),
      );
    }),

  proposeTagsChange: projectScopedMutationProcedure
    .input(ProposeTagsChangeInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctxFor(ctx);
      return stageAndAccept(
        c,
        proposeTagsChange(c, {
          providerItemId: input.providerItemId,
          nextTags: input.nextTags,
        }),
      );
    }),

  proposeAssigneeChange: projectScopedMutationProcedure
    .input(ProposeAssigneeChangeInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctxFor(ctx);
      return stageAndAccept(
        c,
        proposeAssigneeChange(c, {
          providerItemId: input.providerItemId,
          nextAssignee: input.nextAssignee,
        }),
      );
    }),

  proposeReactionToggle: projectScopedMutationProcedure
    .input(ProposeReactionToggleInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctxFor(ctx);
      return stageAndAccept(
        c,
        proposeReactionToggle(c, {
          providerItemId: input.providerItemId,
          targetKind: input.targetKind,
          targetId: input.targetId,
          reaction: input.reaction,
          op: input.op,
        }),
      );
    }),

  confirm: projectScopedApproverProcedure
    .input(ProposalIdInput)
    .mutation(async ({ ctx, input }) => {
      return confirmProposal(ctxFor(ctx), asProposalId(input.proposalId));
    }),

  reject: projectScopedApproverProcedure.input(ProposalIdInput).mutation(async ({ ctx, input }) => {
    return rejectProposal(ctxFor(ctx), asProposalId(input.proposalId));
  }),

  /**
   * Audit feed for the project. Available to anyone with project access
   * (including viewers) — the trail is meant to be transparent. Per the
   * Audit model docstring, rows are append-only and never mutated, so
   * exposing reads is safe even to read-only members.
   */
  auditList: projectScopedProcedure.input(AuditListInput).query(async ({ ctx, input }) => {
    return ctx.db.audit.findMany({
      where: {
        projectId: ctx.projectId,
        ...(input.proposalId ? { proposalId: input.proposalId } : {}),
        ...(input.action ? { action: input.action } : {}),
      },
      orderBy: [{ createdAt: "desc" }],
      take: input.limit,
    });
  }),
});
