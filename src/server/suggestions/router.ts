// Suggestion rows are read+dismiss only (generation is upstream). Command
// usage spans projects, so `recents`/`bump` are `protectedProcedure` (not
// project-scoped) with an optional `projectId` filter/discriminator.

import "server-only";
import { and, desc, eq, exists, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { ProjectId, UserId } from "@/core/types";
import type { Db } from "@/db";
import { commandUsage, projectMemberships, projects, suggestions } from "@/db/schema";
import {
  mutationProcedure,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  projectSlugSchema,
  protectedProcedure,
  router,
} from "@/server/trpc";

async function resolveSlug(db: Db, slug: string, userId: UserId): Promise<ProjectId | null> {
  const row = await db.query.projects.findFirst({
    where: and(
      eq(projects.slug, slug),
      isNull(projects.archivedAt),
      or(
        eq(projects.ownerUserId, userId),
        exists(
          db
            .select({ id: projectMemberships.id })
            .from(projectMemberships)
            .where(
              and(
                eq(projectMemberships.projectId, projects.id),
                eq(projectMemberships.userId, userId),
              ),
            ),
        ),
      ),
    ),
    columns: { id: true },
  });
  return row?.id ?? null;
}

const ListInput = projectSlugSchema.extend({
  kind: z.string().min(1).max(64).optional(),
  includeDismissed: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
});

const DismissInput = projectSlugSchema.extend({ suggestionId: z.string().min(1) });

const RecentsInput = z.object({
  projectSlug: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

const BumpInput = z.object({
  commandId: z.string().min(1).max(120),
  projectSlug: z.string().min(1).optional(),
});

export const suggestionsRouter = router({
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const conditions = [eq(suggestions.projectId, ctx.projectId)];
    if (input.kind) conditions.push(eq(suggestions.kind, input.kind));
    if (!input.includeDismissed) conditions.push(isNull(suggestions.dismissedAt));
    return ctx.db.query.suggestions.findMany({
      where: and(...conditions),
      orderBy: [desc(suggestions.createdAt)],
      limit: input.limit,
    });
  }),

  dismiss: projectScopedMutationProcedure.input(DismissInput).mutation(async ({ ctx, input }) => {
    const updated = await ctx.db
      .update(suggestions)
      .set({ dismissedAt: new Date() })
      .where(
        and(
          eq(suggestions.id, input.suggestionId),
          eq(suggestions.projectId, ctx.projectId),
          isNull(suggestions.dismissedAt),
        ),
      )
      .returning({ id: suggestions.id });
    return { ok: updated.length > 0 };
  }),

  recents: protectedProcedure.input(RecentsInput).query(async ({ ctx, input }) => {
    const userId = ctx.userId;
    const projectId = input.projectSlug
      ? await resolveSlug(ctx.db, input.projectSlug, userId)
      : undefined;
    const conditions = [eq(commandUsage.userId, userId)];
    if (projectId !== undefined) {
      conditions.push(
        projectId === null ? isNull(commandUsage.projectId) : eq(commandUsage.projectId, projectId),
      );
    }
    return ctx.db.query.commandUsage.findMany({
      where: and(...conditions),
      orderBy: [desc(commandUsage.lastUsedAt)],
      limit: input.limit,
    });
  }),

  bump: mutationProcedure.input(BumpInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
    const projectId = input.projectSlug
      ? ((await resolveSlug(ctx.db, input.projectSlug, userId)) ?? null)
      : null;
    const existing = await ctx.db.query.commandUsage.findFirst({
      where: and(
        eq(commandUsage.userId, userId),
        projectId === null ? isNull(commandUsage.projectId) : eq(commandUsage.projectId, projectId),
        eq(commandUsage.commandId, input.commandId),
      ),
      columns: { id: true, usageCount: true },
    });
    if (existing) {
      const [row] = await ctx.db
        .update(commandUsage)
        .set({ usageCount: existing.usageCount + 1, lastUsedAt: new Date() })
        .where(eq(commandUsage.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await ctx.db
      .insert(commandUsage)
      .values({ userId, projectId, commandId: input.commandId })
      .returning();
    return row;
  }),
});
