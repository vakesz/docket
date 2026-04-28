import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ITEM_KINDS, TRANSITION_INTENTS } from "@/core/types";
import {
  hydrateProposal,
  proposeComment,
  proposeDescriptionPatch,
  proposeNewItem,
  proposeTagsChange,
  proposeTransition,
} from "@/server/proposals/builders";
import { diffOf } from "@/server/proposals/diff";
import { confirmProposal, maybeAutoAccept, rejectProposal } from "@/server/proposals/executor";
import {
  projectIdSchema,
  projectScopedApproverProcedure,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  router,
} from "@/server/trpc";

const ItemKindEnum = z.enum(ITEM_KINDS);
const TransitionIntentEnum = z.enum(TRANSITION_INTENTS);

const ListInput = projectIdSchema.extend({
  status: z.enum(["pending", "confirmed", "rejected", "all"]).default("pending"),
  limit: z.number().int().min(1).max(100).default(50),
});

const CountInput = projectIdSchema.extend({
  status: z.enum(["pending", "confirmed", "rejected", "all"]).default("pending"),
});

const ProposalIdInput = projectIdSchema.extend({ proposalId: z.string().min(1) });

const AuditListInput = projectIdSchema.extend({
  /// When set, returns only audit rows for one proposal.
  proposalId: z.string().min(1).optional(),
  /// When set, filters to one action kind (e.g. `proposal.confirm.failed`).
  action: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const ProposeTransitionInput = projectIdSchema.extend({
  providerItemId: z.string().min(1),
  intent: TransitionIntentEnum,
});

const ProposeDescriptionPatchInput = projectIdSchema.extend({
  providerItemId: z.string().min(1),
  newMd: z.string().max(50_000),
});

const ProposeCommentInput = projectIdSchema.extend({
  providerItemId: z.string().min(1),
  bodyMd: z.string().min(1).max(50_000),
});

const ProposeTagsChangeInput = projectIdSchema.extend({
  providerItemId: z.string().min(1),
  nextTags: z.array(z.string().min(1).max(80)).max(50),
});

const ProposeNewItemInput = projectIdSchema.extend({
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
    const row = await ctx.db.proposal.findUnique({ where: { id: input.proposalId } });
    if (!row || row.projectId !== ctx.projectId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "proposal not found" });
    }
    const proposal = hydrateProposal(row);
    return { row, diff: diffOf(proposal) };
  }),

  proposeTransition: projectScopedMutationProcedure
    .input(ProposeTransitionInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctxFor(ctx);
      const row = await maybeAutoAccept(
        c,
        await proposeTransition(c, {
          providerItemId: input.providerItemId,
          intent: input.intent,
        }),
      );
      return { id: row.id, status: row.status, diff: diffOf(hydrateProposal(row)) };
    }),

  proposeDescriptionPatch: projectScopedMutationProcedure
    .input(ProposeDescriptionPatchInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctxFor(ctx);
      const row = await maybeAutoAccept(
        c,
        await proposeDescriptionPatch(c, {
          providerItemId: input.providerItemId,
          newMd: input.newMd,
        }),
      );
      return { id: row.id, status: row.status, diff: diffOf(hydrateProposal(row)) };
    }),

  proposeComment: projectScopedMutationProcedure
    .input(ProposeCommentInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctxFor(ctx);
      const row = await maybeAutoAccept(
        c,
        await proposeComment(c, {
          providerItemId: input.providerItemId,
          bodyMd: input.bodyMd,
        }),
      );
      return { id: row.id, status: row.status, diff: diffOf(hydrateProposal(row)) };
    }),

  proposeNewItem: projectScopedMutationProcedure
    .input(ProposeNewItemInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctxFor(ctx);
      const row = await maybeAutoAccept(
        c,
        await proposeNewItem(c, {
          itemKind: input.itemKind,
          fields: input.fields,
        }),
      );
      return { id: row.id, status: row.status, diff: diffOf(hydrateProposal(row)) };
    }),

  proposeTagsChange: projectScopedMutationProcedure
    .input(ProposeTagsChangeInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctxFor(ctx);
      const row = await maybeAutoAccept(
        c,
        await proposeTagsChange(c, {
          providerItemId: input.providerItemId,
          nextTags: input.nextTags,
        }),
      );
      return { id: row.id, status: row.status, diff: diffOf(hydrateProposal(row)) };
    }),

  confirm: projectScopedApproverProcedure
    .input(ProposalIdInput)
    .mutation(async ({ ctx, input }) => {
      return confirmProposal(ctxFor(ctx), input.proposalId);
    }),

  reject: projectScopedApproverProcedure.input(ProposalIdInput).mutation(async ({ ctx, input }) => {
    return rejectProposal(ctxFor(ctx), input.proposalId);
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
