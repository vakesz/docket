/**
 * Watchlist API.
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
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { asProviderItemId } from "@/core/types";
import { items, watchlistEntries } from "@/db/schema";
import { getProviderSpec } from "@/server/provider-registry";
import {
  projectScopedMutationProcedure,
  projectScopedProcedure,
  projectSlugSchema,
  router,
} from "@/server/trpc";

const ListInput = projectSlugSchema.extend({
  limit: z.number().int().min(1).max(200).default(100),
});

const PinInput = projectSlugSchema.extend({
  providerItemId: z.string().min(1).transform(asProviderItemId),
});

export const watchlistRouter = router({
  /**
   * List the user's pinned items in this project, joined to the cached
   * `Item` rows. Pins for items not currently in cache are silently
   * omitted (the pin row stays — the next sync re-attaches it).
   */
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const userId = ctx.userId;
    const pins = await ctx.db.query.watchlistEntries.findMany({
      where: and(
        eq(watchlistEntries.userId, userId),
        eq(watchlistEntries.projectId, ctx.projectId),
      ),
      orderBy: [desc(watchlistEntries.pinnedAt)],
      limit: input.limit,
    });
    if (pins.length === 0) return [];
    const itemRows = await ctx.db.query.items.findMany({
      where: and(
        eq(items.projectId, ctx.projectId),
        inArray(
          items.providerItemId,
          pins.map((p) => p.providerItemId),
        ),
        eq(items.archived, false),
      ),
      columns: {
        id: true,
        providerItemId: true,
        kind: true,
        title: true,
        state: true,
        url: true,
      },
    });
    const spec = getProviderSpec(ctx.project.providerKind);
    const formatItemNumber = spec?.itemNumberCodec.formatItemNumber ?? ((id: string) => id);
    const byProviderId = new Map(itemRows.map((i) => [i.providerItemId, i]));
    return pins.flatMap((pin) => {
      const item = byProviderId.get(pin.providerItemId);
      if (!item) return [];
      return [
        {
          pinId: pin.id,
          pinnedAt: pin.pinnedAt,
          item: { ...item, itemNumber: formatItemNumber(item.providerItemId) },
        },
      ];
    });
  }),

  isPinned: projectScopedProcedure.input(PinInput).query(async ({ ctx, input }) => {
    const userId = ctx.userId;
    const found = await ctx.db.query.watchlistEntries.findFirst({
      where: and(
        eq(watchlistEntries.userId, userId),
        eq(watchlistEntries.projectId, ctx.projectId),
        eq(watchlistEntries.providerItemId, input.providerItemId),
      ),
      columns: { id: true },
    });
    return { pinned: found !== undefined };
  }),

  pin: projectScopedMutationProcedure.input(PinInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
    const [row] = await ctx.db
      .insert(watchlistEntries)
      .values({
        userId,
        projectId: ctx.projectId,
        providerItemId: input.providerItemId,
      })
      .onConflictDoUpdate({
        target: [
          watchlistEntries.userId,
          watchlistEntries.projectId,
          watchlistEntries.providerItemId,
        ],
        set: {},
      })
      .returning();
    if (!row) throw new Error("watchlist pin returned no row");
    return row;
  }),

  unpin: projectScopedMutationProcedure.input(PinInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
    await ctx.db
      .delete(watchlistEntries)
      .where(
        and(
          eq(watchlistEntries.userId, userId),
          eq(watchlistEntries.projectId, ctx.projectId),
          eq(watchlistEntries.providerItemId, input.providerItemId),
        ),
      );
    return { ok: true };
  }),
});
