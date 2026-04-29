/**
 * Suggestions API.
 *
 * Two related concerns under one router:
 *
 *   1. **Suggestion rows** — `duplicate` / `related` / `transition` hints
 *      surfaced to the user. Generation is upstream (sync or agent writes
 *      rows); this router is read + dismiss only.
 *
 *   2. **Command-usage recency** — recently-used command-palette entries,
 *      ranked by `lastUsedAt` desc. `bump` records a usage; `recents`
 *      returns the top-N for the current user (optionally filtered to one
 *      project).
 *
 * Reads on `projectScopedProcedure` because Suggestions are project-scoped.
 * Recents/bump are protected (not project-scoped) because command usage
 * spans projects — `projectId` is an *optional* filter on read and an
 * optional discriminator on write.
 */

import "server-only";
import { z } from "zod";
import {
  projectIdSchema,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  protectedProcedure,
  router,
} from "@/server/trpc";

const ListInput = projectIdSchema.extend({
  /// Filter by suggestion kind. Empty omits the filter.
  kind: z.string().min(1).max(64).optional(),
  /// When true, also returns dismissed rows. Default hides them.
  includeDismissed: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
});

const DismissInput = projectIdSchema.extend({ suggestionId: z.string().min(1) });

const RecentsInput = z.object({
  /// Optional project filter — when set, only commands used in that
  /// project (or globally with `projectId: null` on write) are returned.
  projectId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

const BumpInput = z.object({
  commandId: z.string().min(1).max(120),
  projectId: z.string().min(1).optional(),
});

export const suggestionsRouter = router({
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    return ctx.db.suggestion.findMany({
      where: {
        projectId: ctx.projectId,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.includeDismissed ? {} : { dismissedAt: null }),
      },
      orderBy: [{ createdAt: "desc" }],
      take: input.limit,
    });
  }),

  dismiss: projectScopedMutationProcedure.input(DismissInput).mutation(async ({ ctx, input }) => {
    const result = await ctx.db.suggestion.updateMany({
      where: { id: input.suggestionId, projectId: ctx.projectId, dismissedAt: null },
      data: { dismissedAt: new Date() },
    });
    if (result.count === 0) {
      // Either the suggestion doesn't exist, isn't in this project, or
      // was already dismissed. Don't differentiate — the client just
      // wanted it gone, and it is.
      return { ok: false };
    }
    return { ok: true };
  }),

  /**
   * Top-N most-recent commands for the current user. Default ranking is by
   * `lastUsedAt` desc, which matches the user mental model ("what did I
   * just do") better than `usageCount` for a personal palette. Both are
   * available on the row if a richer ranking is needed later.
   */
  recents: protectedProcedure.input(RecentsInput).query(async ({ ctx, input }) => {
    const userId = ctx.userId;
    return ctx.db.commandUsage.findMany({
      where: {
        userId,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      },
      orderBy: [{ lastUsedAt: "desc" }],
      take: input.limit,
    });
  }),

  /**
   * Record one usage of `commandId`. Idempotent per (user, project,
   * commandId) — increments the counter and bumps `lastUsedAt`. Pass
   * `projectId` when the command is project-scoped; omit for global
   * commands (the unique key treats `projectId == null` as its own slot).
   */
  bump: protectedProcedure.input(BumpInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
    const projectId = input.projectId ?? null;
    // Compound unique includes a nullable column, so Postgres won't enforce
    // uniqueness on null-projectId rows. Find-then-update/create like the
    // settings router; the (user, project, command) tuple is application-
    // unique even when the DB can't enforce it.
    const existing = await ctx.db.commandUsage.findFirst({
      where: { userId, projectId, commandId: input.commandId },
      select: { id: true, usageCount: true },
    });
    if (existing) {
      return ctx.db.commandUsage.update({
        where: { id: existing.id },
        data: { usageCount: existing.usageCount + 1, lastUsedAt: new Date() },
      });
    }
    return ctx.db.commandUsage.create({
      data: { userId, projectId, commandId: input.commandId },
    });
  }),
});
