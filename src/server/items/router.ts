import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Item, ItemKind, ItemState, StateBucket } from "@/core/types";
import { STATE_BUCKETS } from "@/core/types";
import { applyViewFilter, STATE_BUCKET_MEMBERS, type ViewFilter } from "@/core/view-filter";
import type { Prisma, Item as PrismaItem } from "@/db/generated/client";
import { injectExternalChange, materialDiff } from "@/server/inbound-changes/inject";
import { getProviderSpec } from "@/server/provider-registry";
import { buildProviderForUser } from "@/server/providers/build";
import { runFullSync, runIncrementalSync, toItemRow } from "@/server/sync";
import { projectScopedProcedure, router } from "@/server/trpc";

const ProjectId = z.object({ projectId: z.string().min(1) });

const StateBucketEnum = z.enum(STATE_BUCKETS);

const ListInput = ProjectId.extend({
  kind: z.string().optional(),
  state: z.string().optional(),
  bucket: StateBucketEnum.default("open"),
  /// Optional saved view to apply on top of the inline filters. When set,
  /// the view's stateBucket/assignees/axes win over `bucket` and the inline
  /// `assignees`/`axes` inputs (the surface either drives a saved view or
  /// drives ad-hoc knobs — never both at once).
  viewId: z.string().min(1).optional(),
  /// Inline assignee filter — applied when `viewId` is unset. Empty list =
  /// no constraint. An empty string element means "unassigned".
  assignees: z.array(z.string().min(0).max(200)).max(50).default([]),
  /// Inline per-axis filter — applied when `viewId` is unset. Empty values
  /// are treated as "no constraint" by the view-filter layer.
  axes: z.record(z.string().min(1).max(64), z.string().max(500)).default({}),
  search: z.string().max(200).optional(),
  archived: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(100),
});

const ItemRef = ProjectId.extend({ itemId: z.string().min(1) });

const SyncInput = ProjectId.extend({
  mode: z.enum(["incremental", "full"]).default("incremental"),
});

function userIdOrThrow(ctx: { session: { user: { id?: string } } }): string {
  const userId = ctx.session.user.id;
  if (!userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return userId;
}

type ListInputResolved = z.infer<typeof ListInput>;

/**
 * Resolve the effective view filter for a list call. A `viewId` wins over
 * inline knobs (the surface either drives a saved view or drives ad-hoc
 * inputs, never both). Returns null when no narrowing is requested at all
 * — caller treats that as "open bucket only" via the inline default.
 */
async function resolveViewFilter(
  db: typeof import("@/server/db").db,
  projectId: string,
  userId: string,
  input: ListInputResolved,
): Promise<ViewFilter> {
  if (input.viewId) {
    const row = await db.savedView.findFirst({
      where: { id: input.viewId, userId, projectId },
    });
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "view not found" });
    }
    return {
      stateBucket: row.stateBucket as StateBucket,
      assignees: row.assignees,
      axes: (row.axes ?? {}) as Record<string, string>,
    };
  }
  return {
    stateBucket: input.bucket,
    assignees: input.assignees,
    axes: input.axes,
  };
}

/**
 * Cheap SQL pre-filters that don't need the provider matcher: state bucket
 * (resolves to an `IN` clause via `STATE_BUCKET_MEMBERS`), assignees,
 * archived flag, kind, search. Axes need spec.axisMatcher and are applied
 * in-app downstream.
 *
 * Inline `state` (a single canonical state) wins over the bucket — it's an
 * existing escape hatch for the items page UI and we keep it.
 */
function buildItemListWhere(
  projectId: string,
  input: ListInputResolved,
  view: ViewFilter,
): Prisma.ItemWhereInput {
  const stateClause: Prisma.ItemWhereInput = input.state
    ? { state: input.state }
    : view.stateBucket === "all"
      ? {}
      : { state: { in: [...STATE_BUCKET_MEMBERS[view.stateBucket]] } };

  const assigneeClause: Prisma.ItemWhereInput = (() => {
    if (view.assignees.length === 0) return {};
    const wantUnassigned = view.assignees.includes("");
    const named = view.assignees.filter((a) => a !== "");
    if (wantUnassigned && named.length > 0) {
      return { OR: [{ assignee: null }, { assignee: { in: named } }] };
    }
    if (wantUnassigned) return { assignee: null };
    return { assignee: { in: named } };
  })();

  return {
    projectId,
    archived: input.archived,
    ...(input.kind ? { kind: input.kind } : {}),
    ...stateClause,
    ...assigneeClause,
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
}

function hasAxisFilter(view: ViewFilter): boolean {
  return Object.values(view.axes).some((v) => v !== "");
}

/**
 * Apply provider-axis post-cache narrowing via the spec's matcher. When the
 * provider has no spec or no axis matcher (declared `scopeAxes: []`), this
 * is the identity — same contract as `filterByAxes` in `view-filter.ts`.
 *
 * Cached `Item` rows are Prisma rows, not the canonical `Item` shape, so
 * we lift them through a thin adapter that mirrors what each axisExtract /
 * axisMatcher actually reads off the row. In practice that's just
 * `providerRaw` plus the canonical state/assignee fields the matcher might
 * cross-reference — wide enough that a typical matcher Just Works.
 */
function filterRowsByAxes(
  rows: PrismaItem[],
  view: ViewFilter,
  providerKind: string,
): PrismaItem[] {
  if (!hasAxisFilter(view)) return rows;
  const spec = getProviderSpec(providerKind);
  if (!spec || spec.axisMatcher === null) return rows;
  // Build a (row, lifted) zip so we can keep the original row identity
  // around for the projection step while passing the canonical shape into
  // the matcher.
  const lifted = rows.map((row) => ({ row, item: liftRowToCanonical(row, providerKind) }));
  const filtered = applyViewFilter(
    lifted.map((x) => x.item),
    { stateBucket: "all", assignees: [], axes: view.axes },
    spec.axisMatcher,
  );
  const keep = new Set(filtered.map((i) => i.id));
  return lifted.filter((x) => keep.has(x.item.id)).map((x) => x.row);
}

function liftRowToCanonical(row: PrismaItem, providerKind: string): Item {
  const providerRaw =
    row.providerRaw && typeof row.providerRaw === "object" && !Array.isArray(row.providerRaw)
      ? (row.providerRaw as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    kind: row.kind as ItemKind,
    title: row.title,
    descriptionMd: row.descriptionMd,
    state: row.state as ItemState,
    assignee: row.assignee,
    parentId: row.parentId,
    tags: row.tags,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    url: row.url,
    author: row.author,
    repositoryUrl: row.repositoryUrl,
    attachments: [],
    providerRaw,
    providerKey: `${providerKind}:${row.projectId}`,
  };
}

/**
 * Items API.
 *
 * Reads come straight from the Prisma Item cache so they never need an
 * outbound provider call. The cache is filled by `items.runSync`, which
 * the UI exposes as a "Refresh" button on the items page. Saved-view
 * application — `viewId` resolves to a stored `(stateBucket, assignees,
 * axes)` tuple that narrows the cache the same way inline
 * `bucket`/`assignees`/`axes` would.
 *
 * Project membership is enforced by `projectScopedProcedure`, which also
 * injects `ctx.project` so the mutating procedures don't need a second
 * lookup.
 */
export const itemsRouter = router({
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const userId = userIdOrThrow(ctx);
    const view = await resolveViewFilter(ctx.db, ctx.projectId, userId, input);
    const where = buildItemListWhere(ctx.projectId, input, view);
    const rows = await ctx.db.item.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }],
      // Axes filter is applied in-app via the spec's matcher, so over-fetch
      // by a small factor when axes are present to keep the after-filter
      // page size near the requested limit. When no axes are set the SQL
      // result already matches the final shape.
      take: hasAxisFilter(view) ? Math.min(input.limit * 4, 800) : input.limit,
    });

    const filteredRows = filterRowsByAxes(rows, view, ctx.project.providerKind);
    const trimmed = filteredRows.slice(0, input.limit);

    return trimmed.map((row) => ({
      id: row.id,
      providerItemId: row.providerItemId,
      kind: row.kind,
      title: row.title,
      state: row.state,
      assignee: row.assignee,
      author: row.author,
      tags: row.tags,
      url: row.url,
      updatedAt: row.updatedAt,
      syncedAt: row.syncedAt,
    }));
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
    const userId = userIdOrThrow(ctx);
    return input.mode === "full"
      ? runFullSync(ctx.db, ctx.project, userId)
      : runIncrementalSync(ctx.db, ctx.project, userId);
  }),

  /**
   * Read the project's sync cursor. Powers the settings "Sync" pane so the
   * user can see when the last full walk happened and the watermark the
   * incremental sync will pick up from.
   */
  syncStatus: projectScopedProcedure.input(ProjectId).query(async ({ ctx }) => {
    const cursor = await ctx.db.syncCursor.findUnique({
      where: { projectId: ctx.projectId },
      select: { watermark: true, lastFullSyncAt: true },
    });
    return {
      watermark: cursor?.watermark ?? null,
      lastFullSyncAt: cursor?.lastFullSyncAt ?? null,
    };
  }),

  /**
   * Refresh a single item from its provider — pulls the latest item payload
   * and comments and upserts both. Cheaper than a project-wide sync when the
   * user just wants the open item to be current. Mirrors the sync pipeline so
   * material changes still feed `injectExternalChange` into active
   * conversations.
   */
  refreshItem: projectScopedProcedure.input(ItemRef).mutation(async ({ ctx, input }) => {
    const userId = userIdOrThrow(ctx);
    const cached = await ctx.db.item.findFirst({
      where: { id: input.itemId, projectId: ctx.projectId },
      select: {
        id: true,
        providerItemId: true,
        state: true,
        title: true,
        descriptionMd: true,
        assignee: true,
      },
    });
    if (!cached) {
      throw new TRPCError({ code: "NOT_FOUND", message: "item not found in this project" });
    }
    const provider = await buildProviderForUser(ctx.db, ctx.project, userId);
    const syncedAt = new Date();
    const fresh = await provider.getItem(cached.providerItemId);
    const row = toItemRow(fresh, ctx.projectId, syncedAt);
    const upserted = await ctx.db.item.upsert({
      where: {
        projectId_providerItemId: {
          projectId: ctx.projectId,
          providerItemId: cached.providerItemId,
        },
      },
      create: row,
      update: { ...row, archived: false },
      select: { id: true },
    });

    const changes = materialDiff(cached, fresh);
    let inboundConversations = 0;
    if (changes.length > 0) {
      const result = await injectExternalChange(ctx.db, {
        projectId: ctx.projectId,
        itemId: upserted.id,
        providerItemId: cached.providerItemId,
        changes,
      });
      inboundConversations = result.injectedInto;
    }

    const comments = await provider.getComments(cached.providerItemId);
    if (comments.length > 0) {
      await ctx.db.$transaction(
        comments.map((c) =>
          ctx.db.comment.upsert({
            where: {
              itemId_providerCommentId: {
                itemId: upserted.id,
                providerCommentId: c.id,
              },
            },
            create: {
              itemId: upserted.id,
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
          }),
        ),
      );
    }

    return { commentsCount: comments.length, inboundConversations };
  }),
});
