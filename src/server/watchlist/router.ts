/**
 * Watchlist API (Phase 5).
 *
 * Per-user, per-project pinned items. Pins are keyed by `providerItemId` so
 * a pinned item that temporarily falls outside the active scope still
 * persists — the join to the cached `Item` row in `list` simply omits any
 * pin whose item isn't currently cached.
 *
 * Mutations live on `projectScopedMutationProcedure` because pinning
 * touches a per-user scratchpad; viewers can still read their own pins via
 * `list` on `projectScopedProcedure`.
 */

import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { projectScopedMutationProcedure, projectScopedProcedure, router } from "@/server/trpc";

const ProjectId = z.object({ projectId: z.string().min(1) });

const ListInput = ProjectId.extend({
  limit: z.number().int().min(1).max(200).default(100),
});

const PinInput = ProjectId.extend({
  providerItemId: z.string().min(1),
});

function userIdOrThrow(ctx: { session: { user: { id?: string } } }): string {
  const userId = ctx.session.user.id;
  if (!userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return userId;
}

export const watchlistRouter = router({
  /**
   * List the user's pinned items in this project, joined to the cached
   * `Item` rows. Pins for items not currently in cache are silently
   * omitted (the pin row stays — the next sync re-attaches it).
   */
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const userId = userIdOrThrow(ctx);
    const pins = await ctx.db.watchlistEntry.findMany({
      where: { userId, projectId: ctx.projectId },
      orderBy: [{ pinnedAt: "desc" }],
      take: input.limit,
    });
    if (pins.length === 0) return [];
    const items = await ctx.db.item.findMany({
      where: {
        projectId: ctx.projectId,
        providerItemId: { in: pins.map((p) => p.providerItemId) },
        archived: false,
      },
      select: {
        id: true,
        providerItemId: true,
        kind: true,
        title: true,
        state: true,
        url: true,
      },
    });
    const byProviderId = new Map(items.map((i) => [i.providerItemId, i]));
    return pins.flatMap((pin) => {
      const item = byProviderId.get(pin.providerItemId);
      if (!item) return [];
      return [
        {
          pinId: pin.id,
          pinnedAt: pin.pinnedAt,
          item,
        },
      ];
    });
  }),

  isPinned: projectScopedProcedure.input(PinInput).query(async ({ ctx, input }) => {
    const userId = userIdOrThrow(ctx);
    const found = await ctx.db.watchlistEntry.findUnique({
      where: {
        userId_projectId_providerItemId: {
          userId,
          projectId: ctx.projectId,
          providerItemId: input.providerItemId,
        },
      },
      select: { id: true },
    });
    return { pinned: found !== null };
  }),

  pin: projectScopedMutationProcedure.input(PinInput).mutation(async ({ ctx, input }) => {
    const userId = userIdOrThrow(ctx);
    return ctx.db.watchlistEntry.upsert({
      where: {
        userId_projectId_providerItemId: {
          userId,
          projectId: ctx.projectId,
          providerItemId: input.providerItemId,
        },
      },
      create: {
        userId,
        projectId: ctx.projectId,
        providerItemId: input.providerItemId,
      },
      update: {},
    });
  }),

  unpin: projectScopedMutationProcedure.input(PinInput).mutation(async ({ ctx, input }) => {
    const userId = userIdOrThrow(ctx);
    await ctx.db.watchlistEntry.deleteMany({
      where: {
        userId,
        projectId: ctx.projectId,
        providerItemId: input.providerItemId,
      },
    });
    return { ok: true };
  }),
});
