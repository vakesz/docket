// `setDefault` clears the prior default in the same transaction — the
// "at most one default per (user, project)" invariant has no DB partial
// unique to lean on (Prisma 7 doesn't declare those cleanly yet).

import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { STATE_BUCKETS } from "@/core/types";
import {
  assertFound,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  projectSlugSchema,
  router,
} from "@/server/trpc";

const StateBucketEnum = z.enum(STATE_BUCKETS);

const AssigneeList = z.array(z.string().min(0).max(200)).max(50).default([]);
const AxesMap = z.record(z.string().min(1).max(64), z.string().max(500)).default({});

/**
 * Safe parser for the `SavedView.axes` JSON column. Inputs flow through
 * `AxesMap` at write time, but a corrupt or hand-edited row should still
 * read back as an empty axes map rather than crashing the items query.
 */
export function parseSavedViewAxes(raw: unknown): Record<string, string> {
  const parsed = AxesMap.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

const ViewIdInput = projectSlugSchema.extend({ viewId: z.string().min(1) });

const CreateInput = projectSlugSchema.extend({
  name: z.string().min(1).max(80),
  stateBucket: StateBucketEnum.default("open"),
  assignees: AssigneeList,
  axes: AxesMap,
  isDefault: z.boolean().default(false),
});

const UpdateInput = projectSlugSchema
  .extend({
    viewId: z.string().min(1),
    name: z.string().min(1).max(80).optional(),
    stateBucket: StateBucketEnum.optional(),
    assignees: AssigneeList.optional(),
    axes: AxesMap.optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.stateBucket !== undefined ||
      input.assignees !== undefined ||
      input.axes !== undefined,
    { message: "at least one field (name, stateBucket, assignees, axes) must be supplied" },
  );

export const viewsRouter = router({
  list: projectScopedProcedure.input(projectSlugSchema).query(async ({ ctx }) => {
    const userId = ctx.userId;
    return ctx.db.savedView.findMany({
      where: { userId, projectId: ctx.projectId },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });
  }),

  get: projectScopedProcedure.input(ViewIdInput).query(async ({ ctx, input }) => {
    const userId = ctx.userId;
    return assertFound(
      await ctx.db.savedView.findFirst({
        where: { id: input.viewId, userId, projectId: ctx.projectId },
      }),
      "view not found",
    );
  }),

  create: projectScopedMutationProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
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
    const userId = ctx.userId;
    const result = await ctx.db.savedView.updateMany({
      where: { id: input.viewId, userId, projectId: ctx.projectId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.stateBucket !== undefined ? { stateBucket: input.stateBucket } : {}),
        ...(input.assignees !== undefined ? { assignees: [...input.assignees] } : {}),
        ...(input.axes !== undefined ? { axes: input.axes } : {}),
      },
    });
    if (result.count === 0) {
      throw new TRPCError({ code: "NOT_FOUND", message: "view not found" });
    }
    return ctx.db.savedView.findUniqueOrThrow({ where: { id: input.viewId } });
  }),

  delete: projectScopedMutationProcedure.input(ViewIdInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
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
    const userId = ctx.userId;
    return ctx.db.$transaction(async (tx) => {
      const target = assertFound(
        await tx.savedView.findFirst({
          where: { id: input.viewId, userId, projectId: ctx.projectId },
          select: { id: true, isDefault: true },
        }),
        "view not found",
      );
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
