/**
 * Saved-views API (Phase 9).
 *
 * Per-user, per-project named visual filters. The view itself stores the
 * three narrowing axes the product surfaces (state bucket, assignees, axes
 * map); applying them to cached items lives in `src/core/view-filter.ts`,
 * which is pure and provider-agnostic.
 *
 * Mutations are on `projectScopedMutationProcedure` even though a view is
 * a per-user scratchpad — the role check is what gates non-owner viewers
 * from poking around (consistent with watchlist). Reads stay on
 * `projectScopedProcedure`.
 *
 * `setDefault` clears the prior default in the same transaction so the
 * "at most one default per (user, project)" invariant holds without a DB
 * partial unique index (Prisma 7 doesn't declare those cleanly yet — see
 * the `SavedView` schema comment).
 */

import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { STATE_BUCKETS } from "@/core/types";
import { projectScopedMutationProcedure, projectScopedProcedure, router } from "@/server/trpc";

const ProjectId = z.object({ projectId: z.string().min(1) });

const StateBucketEnum = z.enum(STATE_BUCKETS);

const AssigneeList = z.array(z.string().min(0).max(200)).max(50).default([]);
const AxesMap = z.record(z.string().min(1).max(64), z.string().max(500)).default({});

const ViewIdInput = ProjectId.extend({ viewId: z.string().min(1) });

const CreateInput = ProjectId.extend({
  name: z.string().min(1).max(80),
  stateBucket: StateBucketEnum.default("open"),
  assignees: AssigneeList,
  axes: AxesMap,
  isDefault: z.boolean().default(false),
});

const UpdateInput = ProjectId.extend({
  viewId: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
  stateBucket: StateBucketEnum.optional(),
  assignees: AssigneeList.optional(),
  axes: AxesMap.optional(),
});

function userIdOrThrow(ctx: { session: { user: { id?: string } } }): string {
  const userId = ctx.session.user.id;
  if (!userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return userId;
}

export const viewsRouter = router({
  list: projectScopedProcedure.input(ProjectId).query(async ({ ctx }) => {
    const userId = userIdOrThrow(ctx);
    return ctx.db.savedView.findMany({
      where: { userId, projectId: ctx.projectId },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });
  }),

  get: projectScopedProcedure.input(ViewIdInput).query(async ({ ctx, input }) => {
    const userId = userIdOrThrow(ctx);
    const view = await ctx.db.savedView.findFirst({
      where: { id: input.viewId, userId, projectId: ctx.projectId },
    });
    if (!view) {
      throw new TRPCError({ code: "NOT_FOUND", message: "view not found" });
    }
    return view;
  }),

  create: projectScopedMutationProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    const userId = userIdOrThrow(ctx);
    return ctx.db.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.savedView.updateMany({
          where: { userId, projectId: ctx.projectId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.savedView.create({
        data: {
          userId,
          projectId: ctx.projectId,
          name: input.name,
          stateBucket: input.stateBucket,
          assignees: [...input.assignees],
          axes: input.axes,
          isDefault: input.isDefault,
        },
      });
    });
  }),

  update: projectScopedMutationProcedure.input(UpdateInput).mutation(async ({ ctx, input }) => {
    const userId = userIdOrThrow(ctx);
    const existing = await ctx.db.savedView.findFirst({
      where: { id: input.viewId, userId, projectId: ctx.projectId },
      select: { id: true },
    });
    if (!existing) {
      throw new TRPCError({ code: "NOT_FOUND", message: "view not found" });
    }
    return ctx.db.savedView.update({
      where: { id: input.viewId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.stateBucket !== undefined ? { stateBucket: input.stateBucket } : {}),
        ...(input.assignees !== undefined ? { assignees: [...input.assignees] } : {}),
        ...(input.axes !== undefined ? { axes: input.axes } : {}),
      },
    });
  }),

  delete: projectScopedMutationProcedure.input(ViewIdInput).mutation(async ({ ctx, input }) => {
    const userId = userIdOrThrow(ctx);
    const result = await ctx.db.savedView.deleteMany({
      where: { id: input.viewId, userId, projectId: ctx.projectId },
    });
    if (result.count === 0) {
      throw new TRPCError({ code: "NOT_FOUND", message: "view not found" });
    }
    return { ok: true };
  }),

  /**
   * Mark a view as the user's default for this project. Clears the prior
   * default in the same transaction so the at-most-one invariant holds.
   * No-op (still returns the row) when the view is already the default.
   */
  setDefault: projectScopedMutationProcedure.input(ViewIdInput).mutation(async ({ ctx, input }) => {
    const userId = userIdOrThrow(ctx);
    return ctx.db.$transaction(async (tx) => {
      const target = await tx.savedView.findFirst({
        where: { id: input.viewId, userId, projectId: ctx.projectId },
        select: { id: true, isDefault: true },
      });
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "view not found" });
      }
      if (target.isDefault) {
        return tx.savedView.findUniqueOrThrow({ where: { id: input.viewId } });
      }
      await tx.savedView.updateMany({
        where: { userId, projectId: ctx.projectId, isDefault: true },
        data: { isDefault: false },
      });
      return tx.savedView.update({
        where: { id: input.viewId },
        data: { isDefault: true },
      });
    });
  }),
});
