import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { BacklogBucket, Item, ItemKind, ItemState, StateBucket } from "@/core/types";
import { BACKLOG_BUCKETS } from "@/core/types";
import { applyViewFilter, STATE_BUCKET_MEMBERS, type ViewFilter } from "@/core/view-filter";
import type { Prisma, Item as PrismaItem } from "@/db/generated/client";
import { asPlainObject } from "@/lib/json";
import { injectExternalChange, materialDiff } from "@/server/inbound-changes/inject";
import { getProviderSpec } from "@/server/provider-registry";
import { buildProviderForUser } from "@/server/providers/build";
import {
  loadSyncProgress,
  reconcileComments,
  runFullSync,
  runIncrementalSync,
  toItemRow,
  toSyncProgressLabel,
} from "@/server/sync";
import { assertFound, projectScopedProcedure, projectSlugSchema, router } from "@/server/trpc";
import { parseSavedViewAxes } from "@/server/views/router";

/**
 * Translate the URL-facing `itemNumber` into the provider's stored
 * `providerItemId` for `(projectId, providerItemId)` lookups. Throws
 * `BAD_REQUEST` when the number doesn't match the provider's expected shape
 * (e.g. non-numeric slug for GitHub/AzDO) — items live behind the route's
 * dynamic segment, so a malformed slot is a 400 rather than a 500.
 */
function resolveProviderItemId(
  providerKind: string,
  providerScope: unknown,
  itemNumber: string,
): string {
  const spec = getProviderSpec(providerKind);
  if (!spec) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "unknown provider kind",
    });
  }
  const providerItemId = spec.itemNumberCodec.parseItemNumber(
    asPlainObject(providerScope),
    itemNumber,
  );
  if (!providerItemId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `invalid item identifier "${itemNumber}" for this project`,
    });
  }
  return providerItemId;
}

const BacklogBucketEnum = z.enum(BACKLOG_BUCKETS);

const ListInput = projectSlugSchema.extend({
  kind: z.string().optional(),
  state: z.string().optional(),
  bucket: BacklogBucketEnum.default("open"),
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
  limit: z.number().int().min(1).max(200).default(100),
});

const ItemRef = projectSlugSchema.extend({ itemNumber: z.string().min(1) });

const SyncInput = projectSlugSchema.extend({
  mode: z.enum(["incremental", "full"]).default("incremental"),
});

type ListInputResolved = z.infer<typeof ListInput>;

type ResolvedFilter = {
  view: ViewFilter;
  /// `true` = only archived rows, `false` = only non-archived, `undefined`
  /// = no archived clause (both kinds visible). Saved views default to
  /// non-archived since they store a canonical `StateBucket` and never the
  /// cache-only archived axis.
  archivedFlag: boolean | undefined;
};

/**
 * Map a `BacklogBucket` to the canonical state bucket used by saved views
 * and the in-memory filter, plus the cache-only archived flag. The four
 * buckets correspond to: open/closed → state filter on non-archived rows,
 * archived → no state filter on archived rows, all → no filter at all.
 */
function bucketToFilter(bucket: BacklogBucket): {
  stateBucket: StateBucket;
  archivedFlag: boolean | undefined;
} {
  switch (bucket) {
    case "archived":
      return { stateBucket: "all", archivedFlag: true };
    case "all":
      return { stateBucket: "all", archivedFlag: undefined };
    default:
      return { stateBucket: bucket, archivedFlag: false };
  }
}

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
): Promise<ResolvedFilter> {
  if (input.viewId) {
    const row = assertFound(
      await db.savedView.findFirst({
        where: { id: input.viewId, userId, projectId },
      }),
      "view not found",
    );
    return {
      view: {
        stateBucket: row.stateBucket as StateBucket,
        assignees: row.assignees,
        axes: parseSavedViewAxes(row.axes),
      },
      archivedFlag: false,
    };
  }
  const { stateBucket, archivedFlag } = bucketToFilter(input.bucket);
  return {
    view: {
      stateBucket,
      assignees: input.assignees,
      axes: input.axes,
    },
    archivedFlag,
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
  archivedFlag: boolean | undefined,
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
    ...(archivedFlag === undefined ? {} : { archived: archivedFlag }),
    ...(input.kind ? { kind: input.kind } : {}),
    ...stateClause,
    ...assigneeClause,
    ...(input.search
      ? {
          OR: [
            { title: { contains: input.search, mode: "insensitive" } },
            { description: { contains: input.search, mode: "insensitive" } },
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
  const lifted = rows.map((row) => ({
    row,
    item: liftRowToCanonical(row, providerKind),
  }));
  const filtered = applyViewFilter(
    lifted.map((x) => x.item),
    { stateBucket: "all", assignees: [], axes: view.axes },
    spec.axisMatcher,
  );
  const keep = new Set(filtered.map((i) => i.id));
  return lifted.filter((x) => keep.has(x.item.id)).map((x) => x.row);
}

function liftRowToCanonical(row: PrismaItem, providerKind: string): Item {
  const providerRaw = asPlainObject(row.providerRaw);
  return {
    id: row.id,
    kind: row.kind as ItemKind,
    title: row.title,
    description: row.description,
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
    const userId = ctx.userId;
    const { view, archivedFlag } = await resolveViewFilter(ctx.db, ctx.projectId, userId, input);
    const where = buildItemListWhere(ctx.projectId, input, view, archivedFlag);
    const axesActive = hasAxisFilter(view);
    // The provider matcher reads providerRaw via liftRowToCanonical, so we
    // can only narrow the SQL projection when no axis filter is active.
    // Otherwise we'd lose the column the matcher needs.
    const rows = axesActive
      ? await ctx.db.item.findMany({
          where,
          orderBy: [{ updatedAt: "desc" }],
          take: Math.min(input.limit * 4, 800),
        })
      : await ctx.db.item.findMany({
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

    const filteredRows = axesActive
      ? filterRowsByAxes(rows as PrismaItem[], view, ctx.project.providerKind).slice(0, input.limit)
      : rows;

    const spec = getProviderSpec(ctx.project.providerKind);
    const formatItemNumber = spec?.itemNumberCodec.formatItemNumber ?? ((id: string) => id);

    return filteredRows.map((row) => ({
      id: row.id,
      providerItemId: row.providerItemId,
      itemNumber: formatItemNumber(row.providerItemId),
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
    const spec = getProviderSpec(ctx.project.providerKind);
    if (!spec) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "unknown provider kind",
      });
    }
    const providerItemId = resolveProviderItemId(
      ctx.project.providerKind,
      ctx.project.providerScope,
      input.itemNumber,
    );
    // Explicit select keeps the `providerRaw` JSON blob (often kilobytes of
    // unfiltered provider response) off the wire — nothing in the UI reads it.
    const row = assertFound(
      await ctx.db.item.findFirst({
        where: { providerItemId, projectId: ctx.projectId },
        select: {
          id: true,
          projectId: true,
          providerItemId: true,
          kind: true,
          title: true,
          description: true,
          state: true,
          assignee: true,
          author: true,
          parentId: true,
          tags: true,
          url: true,
          reactions: true,
          createdAt: true,
          updatedAt: true,
          syncedAt: true,
          comments: {
            orderBy: [{ createdAt: "asc" }],
            select: {
              id: true,
              providerCommentId: true,
              author: true,
              body: true,
              reactions: true,
              createdAt: true,
            },
          },
        },
      }),
      "item not found in this project",
    );
    const formatItemNumber = spec.itemNumberCodec.formatItemNumber;
    return {
      ...row,
      itemNumber: formatItemNumber(row.providerItemId),
      parentNumber: row.parentId ? formatItemNumber(row.parentId) : null,
    };
  }),

  search: projectScopedProcedure
    .input(
      projectSlugSchema.extend({
        q: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.item.findMany({
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
      const spec = getProviderSpec(ctx.project.providerKind);
      const formatItemNumber = spec?.itemNumberCodec.formatItemNumber ?? ((id: string) => id);
      return rows.map((row) => ({
        ...row,
        itemNumber: formatItemNumber(row.providerItemId),
      }));
    }),

  /**
   * Sync the project from its provider. `mode: "incremental"` is the cheap
   * watermark-based pull; `mode: "full"` walks everything and archives any
   * cached row the provider no longer returns. Both bump SyncCursor.
   */
  runSync: projectScopedProcedure.input(SyncInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
    return input.mode === "full"
      ? runFullSync(ctx.db, ctx.project, userId)
      : runIncrementalSync(ctx.db, ctx.project, userId);
  }),

  /**
   * Read the project's sync cursor. Powers the settings "Sync" pane so the
   * user can see when the last full walk happened and the watermark the
   * incremental sync will pick up from. Also feeds the status footer's
   * 'synced X ago' indicator via `lastSyncAt`, which is the most-recent of
   * the cursor's three timestamps — `updatedAt` covers syncs that ran but
   * didn't bump either payload column.
   */
  syncStatus: projectScopedProcedure.input(projectSlugSchema).query(async ({ ctx }) => {
    const [cursor, progress] = await Promise.all([
      ctx.db.syncCursor.findUnique({
        where: { projectId: ctx.projectId },
        select: { watermark: true, lastFullSyncAt: true, updatedAt: true },
      }),
      loadSyncProgress(ctx.db, ctx.projectId),
    ]);

    return {
      watermark: cursor?.watermark ?? null,
      lastFullSyncAt: cursor?.lastFullSyncAt ?? null,
      lastSyncAt: cursor
        ? [cursor.watermark, cursor.lastFullSyncAt, cursor.updatedAt].reduce<Date | null>(
            (best, d) => (d && (!best || d.getTime() > best.getTime()) ? d : best),
            null,
          )
        : null,
      progress: progress
        ? {
            runId: progress.runId,
            mode: progress.mode,
            status: progress.status,
            phase: progress.phase,
            phaseLabel: toSyncProgressLabel(progress.phase),
            startedAt: progress.startedAt,
            updatedAt: progress.updatedAt,
            finishedAt: progress.finishedAt,
            chunksCompleted: progress.chunksCompleted,
            itemsSeen: progress.itemsSeen,
            upserted: progress.upserted,
            archived: progress.archived,
            inboundConversations: progress.inboundConversations,
            commentsReconciled: progress.commentsReconciled,
            watermark: progress.watermark,
            error: progress.error,
          }
        : null,
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
    const userId = ctx.userId;
    const providerItemId = resolveProviderItemId(
      ctx.project.providerKind,
      ctx.project.providerScope,
      input.itemNumber,
    );
    const cached = assertFound(
      await ctx.db.item.findFirst({
        where: { providerItemId, projectId: ctx.projectId },
        select: {
          id: true,
          projectId: true,
          providerItemId: true,
          state: true,
          title: true,
          description: true,
          assignee: true,
        },
      }),
      "item not found in this project",
    );
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
    await reconcileComments(ctx.db, [{ itemSurrogate: upserted.id, comments }]);

    return { commentsCount: comments.length, inboundConversations };
  }),
});
