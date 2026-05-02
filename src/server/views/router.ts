// `setDefault` clears the prior default in the same transaction — the
// "at most one default per (user, project)" invariant has no DB partial
// unique to lean on.

import "server-only";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { STATE_BUCKETS } from "@/core/types";
import { savedViews } from "@/db/schema";
import {
  assertFound,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  projectSlugSchema,
  router,
} from "@/server/trpc";

const StateBucketEnum = z.enum(STATE_BUCKETS);

const AssigneeList = z.array(z.string().min(0).max(200)).max(50).default([]);
const FacetsMap = z.record(z.string().min(1).max(64), z.string().max(500)).default({});

/**
 * Safe parser for the `SavedView.facets` JSON column. Inputs flow through
 * `FacetsMap` at write time, but a corrupt or hand-edited row should still
 * read back as an empty facets map rather than crashing the items query.
 */
export function parseSavedViewFacets(raw: unknown): Record<string, string> {
  const parsed = FacetsMap.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

const ViewIdInput = projectSlugSchema.extend({ viewId: z.string().min(1) });

const CreateInput = projectSlugSchema.extend({
  name: z.string().min(1).max(80),
  stateBucket: StateBucketEnum.default("open"),
  assignees: AssigneeList,
  facets: FacetsMap,
  isDefault: z.boolean().default(false),
});

const UpdateInput = projectSlugSchema
  .extend({
    viewId: z.string().min(1),
    name: z.string().min(1).max(80).optional(),
    stateBucket: StateBucketEnum.optional(),
    assignees: AssigneeList.optional(),
    facets: FacetsMap.optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.stateBucket !== undefined ||
      input.assignees !== undefined ||
      input.facets !== undefined,
    { message: "at least one field (name, stateBucket, assignees, facets) must be supplied" },
  );

export const viewsRouter = router({
  list: projectScopedProcedure.input(projectSlugSchema).query(async ({ ctx }) => {
    const userId = ctx.userId;
    return ctx.db.query.savedViews.findMany({
      where: and(eq(savedViews.userId, userId), eq(savedViews.projectId, ctx.projectId)),
      orderBy: [desc(savedViews.isDefault), asc(savedViews.name)],
    });
  }),

  get: projectScopedProcedure.input(ViewIdInput).query(async ({ ctx, input }) => {
    const userId = ctx.userId;
    return assertFound(
      await ctx.db.query.savedViews.findFirst({
        where: and(
          eq(savedViews.id, input.viewId),
          eq(savedViews.userId, userId),
          eq(savedViews.projectId, ctx.projectId),
        ),
      }),
      "view not found",
    );
  }),

  create: projectScopedMutationProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
    return ctx.db.transaction(async (tx) => {
      if (input.isDefault) {
        await tx
          .update(savedViews)
          .set({ isDefault: false })
          .where(
            and(
              eq(savedViews.userId, userId),
              eq(savedViews.projectId, ctx.projectId),
              eq(savedViews.isDefault, true),
            ),
          );
      }
      const [row] = await tx
        .insert(savedViews)
        .values({
          userId,
          projectId: ctx.projectId,
          name: input.name,
          stateBucket: input.stateBucket,
          assignees: [...input.assignees],
          facets: input.facets,
          isDefault: input.isDefault,
        })
        .returning();
      if (!row) throw new Error("saved view create returned no row");
      return row;
    });
  }),

  update: projectScopedMutationProcedure.input(UpdateInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
    const [row] = await ctx.db
      .update(savedViews)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.stateBucket !== undefined ? { stateBucket: input.stateBucket } : {}),
        ...(input.assignees !== undefined ? { assignees: [...input.assignees] } : {}),
        ...(input.facets !== undefined ? { facets: input.facets } : {}),
      })
      .where(
        and(
          eq(savedViews.id, input.viewId),
          eq(savedViews.userId, userId),
          eq(savedViews.projectId, ctx.projectId),
        ),
      )
      .returning();
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "view not found" });
    }
    return row;
  }),

  delete: projectScopedMutationProcedure.input(ViewIdInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
    const deleted = await ctx.db
      .delete(savedViews)
      .where(
        and(
          eq(savedViews.id, input.viewId),
          eq(savedViews.userId, userId),
          eq(savedViews.projectId, ctx.projectId),
        ),
      )
      .returning({ id: savedViews.id });
    if (deleted.length === 0) {
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
    return ctx.db.transaction(async (tx) => {
      const target = assertFound(
        await tx.query.savedViews.findFirst({
          where: and(
            eq(savedViews.id, input.viewId),
            eq(savedViews.userId, userId),
            eq(savedViews.projectId, ctx.projectId),
          ),
          columns: { id: true, isDefault: true },
        }),
        "view not found",
      );
      if (target.isDefault) {
        const current = assertFound(
          await tx.query.savedViews.findFirst({
            where: eq(savedViews.id, input.viewId),
          }),
          "view not found",
        );
        return current;
      }
      await tx
        .update(savedViews)
        .set({ isDefault: false })
        .where(
          and(
            eq(savedViews.userId, userId),
            eq(savedViews.projectId, ctx.projectId),
            eq(savedViews.isDefault, true),
          ),
        );
      const [row] = await tx
        .update(savedViews)
        .set({ isDefault: true })
        .where(eq(savedViews.id, input.viewId))
        .returning();
      if (!row) throw new Error("saved view setDefault returned no row");
      return row;
    });
  }),
});
