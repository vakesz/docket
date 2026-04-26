import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Prisma } from "@/db/generated/client";
import { buildProviderForUser } from "@/server/providers/build";
import { runFullSync, runIncrementalSync } from "@/server/sync";
import { projectScopedProcedure, router } from "@/server/trpc";

const ProjectId = z.object({ projectId: z.string().min(1) });

const ListInput = ProjectId.extend({
  kind: z.string().optional(),
  state: z.string().optional(),
  bucket: z.enum(["open", "closed", "all"]).default("open"),
  search: z.string().max(200).optional(),
  archived: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(100),
});

const ItemRef = ProjectId.extend({ itemId: z.string().min(1) });

const SyncInput = ProjectId.extend({
  mode: z.enum(["incremental", "full"]).default("incremental"),
});

/**
 * Items API (Phase 3).
 *
 * Reads come straight from the Prisma Item cache so they never need an
 * outbound provider call. The cache is filled by `items.runSync`, which
 * the UI exposes as a "Refresh" button on the items page. Phase 4 wires
 * proposal-first writes; Phase 5 wires real-time inbound updates.
 *
 * Project membership is enforced by `projectScopedProcedure`, which also
 * injects `ctx.project` so the mutating procedures don't need a second
 * lookup. (`mutationProcedure` and `projectScopedProcedure` will be
 * composed by Phase 10 once the read-only / role gates land.)
 */
export const itemsRouter = router({
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const where: Prisma.ItemWhereInput = {
      projectId: ctx.projectId,
      archived: input.archived,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.state
        ? { state: input.state }
        : input.bucket === "open"
          ? { state: { in: ["new", "active", "blocked", "needs_info"] } }
          : input.bucket === "closed"
            ? { state: { in: ["resolved", "closed"] } }
            : {}),
      ...(input.search
        ? {
            OR: [
              { title: { contains: input.search, mode: "insensitive" } },
              { descriptionMd: { contains: input.search, mode: "insensitive" } },
              { providerItemId: { contains: input.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    return ctx.db.item.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }],
      take: input.limit,
      select: {
        id: true,
        providerItemId: true,
        kind: true,
        title: true,
        state: true,
        assignee: true,
        author: true,
        tags: true,
        url: true,
        updatedAt: true,
        syncedAt: true,
      },
    });
  }),

  get: projectScopedProcedure.input(ItemRef).query(async ({ ctx, input }) => {
    const item = await ctx.db.item.findFirst({
      where: { projectId: ctx.projectId, id: input.itemId },
      include: {
        comments: { orderBy: [{ createdAt: "asc" }] },
      },
    });
    if (!item) {
      throw new TRPCError({ code: "NOT_FOUND", message: "item not found in this project" });
    }
    return item;
  }),

  search: projectScopedProcedure
    .input(
      ProjectId.extend({
        q: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      return ctx.db.item.findMany({
        where: {
          projectId: ctx.projectId,
          archived: false,
          OR: [
            { title: { contains: input.q, mode: "insensitive" } },
            { providerItemId: { contains: input.q, mode: "insensitive" } },
          ],
        },
        orderBy: [{ updatedAt: "desc" }],
        take: input.limit,
        select: {
          id: true,
          providerItemId: true,
          title: true,
          state: true,
          kind: true,
          url: true,
        },
      });
    }),

  /**
   * Sync the project from its provider. `mode: "incremental"` is the cheap
   * watermark-based pull; `mode: "full"` walks everything and archives any
   * cached row the provider no longer returns. Both bump SyncCursor.
   */
  runSync: projectScopedProcedure.input(SyncInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    if (!userId) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    return input.mode === "full"
      ? runFullSync(ctx.db, ctx.project, userId)
      : runIncrementalSync(ctx.db, ctx.project, userId);
  }),

  /**
   * Refresh comments for one item from the provider and upsert into the
   * Comment cache. Cheap to run on detail-page open.
   */
  refreshComments: projectScopedProcedure.input(ItemRef).mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    if (!userId) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    const item = await ctx.db.item.findFirst({
      where: { id: input.itemId, projectId: ctx.projectId },
    });
    if (!item) {
      throw new TRPCError({ code: "NOT_FOUND", message: "item not found in this project" });
    }
    const provider = await buildProviderForUser(ctx.db, ctx.project, userId);
    const fresh = await provider.getComments(item.providerItemId);
    for (const c of fresh) {
      await ctx.db.comment.upsert({
        where: {
          itemId_providerCommentId: {
            itemId: item.id,
            providerCommentId: c.id,
          },
        },
        create: {
          itemId: item.id,
          providerCommentId: c.id,
          author: c.author,
          bodyMd: c.bodyMd,
          createdAt: c.createdAt,
        },
        update: {
          author: c.author,
          bodyMd: c.bodyMd,
          createdAt: c.createdAt,
        },
      });
    }
    return { count: fresh.length };
  }),
});
