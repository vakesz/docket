import "server-only";
import { TRPCError } from "@trpc/server";
import { and, arrayContains, asc, desc, eq, ilike, isNotNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assertItemKind,
  assertItemState,
  asProviderItemId,
  BACKLOG_BUCKETS,
  type BacklogBucket,
  type Item,
  type ProjectId,
  type ProviderItemId,
  type StateBucket,
  type UserId,
} from "@/core/types";
import { applyViewFilter, STATE_BUCKET_MEMBERS, type ViewFilter } from "@/core/view-filter";
import type { Db } from "@/db";
import { comments, items, savedViews, syncCursors } from "@/db/schema";
import type { Item as ItemRow } from "@/db/schema/types";
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
import { parseSavedViewFacets } from "@/server/views/router";

function resolveProviderItemId(
  providerKind: string,
  providerScope: unknown,
  itemNumber: string,
): ProviderItemId {
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
  return asProviderItemId(providerItemId);
}

const BacklogBucketEnum = z.enum(BACKLOG_BUCKETS);

const ListInput = projectSlugSchema.extend({
  kind: z.string().optional(),
  state: z.string().optional(),
  bucket: BacklogBucketEnum.default("open"),
  viewId: z.string().min(1).optional(),
  assignees: z.array(z.string().min(0).max(200)).max(50).default([]),
  facets: z.record(z.string().min(1).max(64), z.string().max(500)).default({}),
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
  archivedFlag: boolean | undefined;
};

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

async function resolveViewFilter(
  db: Db,
  projectId: ProjectId,
  userId: UserId,
  input: ListInputResolved,
): Promise<ResolvedFilter> {
  if (input.viewId) {
    const row = assertFound(
      await db.query.savedViews.findFirst({
        where: and(
          eq(savedViews.id, input.viewId),
          eq(savedViews.userId, userId),
          eq(savedViews.projectId, projectId),
        ),
      }),
      "view not found",
    );
    return {
      view: {
        stateBucket: row.stateBucket,
        assignees: row.assignees,
        facets: parseSavedViewFacets(row.facets),
      },
      archivedFlag: false,
    };
  }
  const { stateBucket, archivedFlag } = bucketToFilter(input.bucket);
  return {
    view: {
      stateBucket,
      assignees: input.assignees,
      facets: input.facets,
    },
    archivedFlag,
  };
}

/**
 * Build a Drizzle WHERE expression from the cheap SQL pre-filters: state
 * bucket, assignees (Postgres array overlap), archived flag, kind, search.
 * Facets need spec.facetMatcher and are applied in-app downstream.
 */
function buildItemListWhere(
  projectId: ProjectId,
  input: ListInputResolved,
  view: ViewFilter,
  archivedFlag: boolean | undefined,
) {
  const conditions = [eq(items.projectId, projectId)];
  if (archivedFlag !== undefined) conditions.push(eq(items.archived, archivedFlag));
  if (input.kind) conditions.push(eq(items.kind, assertItemKind(input.kind, "ListInput.kind")));

  if (input.state) {
    conditions.push(eq(items.state, assertItemState(input.state, "ListInput.state")));
  } else if (view.stateBucket !== "all") {
    const states = STATE_BUCKET_MEMBERS[view.stateBucket];
    conditions.push(
      sql`${items.state} = ANY(${sql.raw(`ARRAY[${states.map((s) => `'${s.replace(/'/g, "''")}'`).join(",")}]`)})`,
    );
  }

  if (view.assignees.length > 0) {
    const wantUnassigned = view.assignees.includes("");
    const named = view.assignees.filter((a) => a !== "");
    const namedClause = named.length > 0 ? arrayContains(items.assignees, named) : undefined;
    const unassignedClause = wantUnassigned
      ? sql`array_length(${items.assignees}, 1) IS NULL`
      : undefined;
    if (namedClause && unassignedClause) {
      const combined = or(namedClause, unassignedClause);
      if (combined) conditions.push(combined);
    } else if (namedClause) {
      conditions.push(namedClause);
    } else if (unassignedClause) {
      conditions.push(unassignedClause);
    }
  }

  if (input.search) {
    const pattern = `%${input.search}%`;
    const searchClause = or(
      ilike(items.title, pattern),
      ilike(items.description, pattern),
      ilike(items.providerItemId, pattern),
    );
    if (searchClause) conditions.push(searchClause);
  }

  return and(...conditions);
}

function hasFacetFilter(view: ViewFilter): boolean {
  return Object.values(view.facets).some((v) => v !== "");
}

const LIST_ROW_COLUMNS = {
  id: true,
  projectId: true,
  providerItemId: true,
  kind: true,
  title: true,
  description: true,
  state: true,
  assignees: true,
  author: true,
  parentId: true,
  tags: true,
  url: true,
  createdAt: true,
  updatedAt: true,
  syncedAt: true,
  repositoryUrl: true,
  providerRaw: true,
} as const;

const LIST_NARROW_COLUMNS = {
  id: true,
  providerItemId: true,
  kind: true,
  title: true,
  state: true,
  assignees: true,
  author: true,
  tags: true,
  url: true,
  updatedAt: true,
  syncedAt: true,
} as const;

type ListRow = Pick<ItemRow, keyof typeof LIST_ROW_COLUMNS>;

function filterRowsByFacets(rows: ListRow[], view: ViewFilter, providerKind: string): ListRow[] {
  if (!hasFacetFilter(view)) return rows;
  const spec = getProviderSpec(providerKind);
  if (!spec || spec.facetMatcher === null) return rows;
  const lifted = rows.map((row) => ({
    row,
    item: liftRowToCanonical(row, providerKind),
  }));
  const filtered = applyViewFilter(
    lifted.map((x) => x.item),
    { stateBucket: "all", assignees: [], facets: view.facets },
    spec.facetMatcher,
  );
  const keep = new Set(filtered.map((i) => i.id));
  return lifted.filter((x) => keep.has(x.item.id)).map((x) => x.row);
}

function liftRowToCanonical(row: ListRow, providerKind: string): Item {
  const providerRaw = asPlainObject(row.providerRaw);
  return {
    id: row.id,
    kind: assertItemKind(row.kind, `Item ${row.id}.kind`),
    title: row.title,
    description: row.description,
    state: assertItemState(row.state, `Item ${row.id}.state`),
    assignee: row.assignees[0] ?? null,
    parentId: row.parentId,
    tags: row.tags,
    createdAt: row.createdAt ?? row.updatedAt,
    updatedAt: row.updatedAt,
    url: row.url,
    author: row.author,
    repositoryUrl: row.repositoryUrl,
    attachments: [],
    providerRaw,
    providerKey: `${providerKind}:${row.projectId}`,
  };
}

export const itemsRouter = router({
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const userId = ctx.userId;
    const { view, archivedFlag } = await resolveViewFilter(ctx.db, ctx.projectId, userId, input);
    const where = buildItemListWhere(ctx.projectId, input, view, archivedFlag);
    const facetsActive = hasFacetFilter(view);
    const rows = facetsActive
      ? await ctx.db.query.items.findMany({
          where,
          orderBy: [desc(items.updatedAt)],
          limit: Math.min(input.limit * 4, 800),
          columns: LIST_ROW_COLUMNS,
        })
      : await ctx.db.query.items.findMany({
          where,
          orderBy: [desc(items.updatedAt)],
          limit: input.limit,
          columns: LIST_NARROW_COLUMNS,
        });

    const filteredRows = facetsActive
      ? filterRowsByFacets(rows as ListRow[], view, ctx.project.providerKind).slice(0, input.limit)
      : rows;

    const spec = getProviderSpec(ctx.project.providerKind);
    const formatItemNumber = spec?.itemNumberCodec.formatItemNumber ?? ((id: string) => id);

    return filteredRows.map((row) => ({
      id: row.id,
      providerItemId: row.providerItemId,
      itemNumber: formatItemNumber(row.providerItemId),
      kind: assertItemKind(row.kind, `Item ${row.id}.kind`),
      title: row.title,
      state: assertItemState(row.state, `Item ${row.id}.state`),
      assignee: row.assignees[0] ?? null,
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
    const row = assertFound(
      await ctx.db.query.items.findFirst({
        where: and(eq(items.projectId, ctx.projectId), eq(items.providerItemId, providerItemId)),
        columns: {
          id: true,
          projectId: true,
          providerItemId: true,
          kind: true,
          title: true,
          description: true,
          state: true,
          assignees: true,
          author: true,
          parentId: true,
          tags: true,
          url: true,
          reactions: true,
          createdAt: true,
          updatedAt: true,
          syncedAt: true,
        },
        with: {
          comments: {
            orderBy: [asc(comments.createdAt)],
            columns: {
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
      assignee: row.assignees[0] ?? null,
      itemNumber: formatItemNumber(row.providerItemId),
      parentNumber: row.parentId ? formatItemNumber(row.parentId) : null,
    };
  }),

  /**
   * Distinct, sorted list of tags currently in use across the project's
   * cached items. Powers the tag-editor autocomplete on the item detail
   * pane. State-encoding labels declared by the provider are filtered out.
   */
  listProjectTags: projectScopedProcedure.input(projectSlugSchema).query(async ({ ctx }) => {
    const rows = await ctx.db.execute<{ tag: string }>(sql`
      SELECT DISTINCT UNNEST(${items.tags}) AS tag
      FROM ${items}
      WHERE ${items.projectId} = ${ctx.projectId}
      ORDER BY tag ASC
      LIMIT 500
    `);
    const spec = getProviderSpec(ctx.project.providerKind);
    const reserved = new Set(
      (spec?.capabilities.stateEncodingTags ?? []).map((t) => t.toLowerCase()),
    );
    return (rows as Array<{ tag: string }>)
      .map((r) => r.tag)
      .filter((tag) => tag && !reserved.has(tag.toLowerCase()));
  }),

  /**
   * Distinct non-null assignees seen in cached items in this project.
   */
  listProjectAssignees: projectScopedProcedure.input(projectSlugSchema).query(async ({ ctx }) => {
    const rows = await ctx.db.execute<{ assignee: string }>(sql`
      SELECT DISTINCT UNNEST(${items.assignees}) AS assignee
      FROM ${items}
      WHERE ${items.projectId} = ${ctx.projectId}
      ORDER BY assignee ASC
      LIMIT 500
    `);
    return (rows as Array<{ assignee: string }>)
      .map((r) => r.assignee)
      .filter((a): a is string => !!a);
  }),

  currentUserIdentity: projectScopedProcedure.input(projectSlugSchema).query(async ({ ctx }) => {
    try {
      const provider = await buildProviderForUser(ctx.db, ctx.project, ctx.userId);
      return await provider.currentUserIdentity();
    } catch {
      return null;
    }
  }),

  search: projectScopedProcedure
    .input(
      projectSlugSchema.extend({
        q: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const pattern = `%${input.q}%`;
      const rows = await ctx.db.query.items.findMany({
        where: and(
          eq(items.projectId, ctx.projectId),
          eq(items.archived, false),
          or(ilike(items.title, pattern), ilike(items.providerItemId, pattern)),
        ),
        orderBy: [desc(items.updatedAt)],
        limit: input.limit,
        columns: {
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

  runSync: projectScopedProcedure.input(SyncInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
    return input.mode === "full"
      ? runFullSync(ctx.db, ctx.project, userId)
      : runIncrementalSync(ctx.db, ctx.project, userId);
  }),

  syncStatus: projectScopedProcedure.input(projectSlugSchema).query(async ({ ctx }) => {
    const [cursor, progress] = await Promise.all([
      ctx.db.query.syncCursors.findFirst({
        where: eq(syncCursors.projectId, ctx.projectId),
        columns: { watermark: true, lastFullSyncAt: true, updatedAt: true },
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

  refreshItem: projectScopedProcedure.input(ItemRef).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
    const providerItemId = resolveProviderItemId(
      ctx.project.providerKind,
      ctx.project.providerScope,
      input.itemNumber,
    );
    const cached = assertFound(
      await ctx.db.query.items.findFirst({
        where: and(eq(items.projectId, ctx.projectId), eq(items.providerItemId, providerItemId)),
        columns: {
          id: true,
          projectId: true,
          providerItemId: true,
          state: true,
          title: true,
          description: true,
          assignees: true,
        },
      }),
      "item not found in this project",
    );
    const provider = await buildProviderForUser(ctx.db, ctx.project, userId);
    const syncedAt = new Date();
    const fresh = await provider.getItem(cached.providerItemId);
    const row = toItemRow(fresh, ctx.projectId, syncedAt);
    const [upserted] = await ctx.db
      .insert(items)
      .values(row)
      .onConflictDoUpdate({
        target: [items.projectId, items.providerItemId],
        set: { ...row, archived: false },
      })
      .returning({ id: items.id });
    if (!upserted) throw new Error("item upsert returned no row");

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

    const providerComments = await provider.getComments(cached.providerItemId);
    await reconcileComments(ctx.db, [{ itemSurrogate: upserted.id, comments: providerComments }]);

    return { commentsCount: providerComments.length, inboundConversations };
  }),
});

// Quiet unused import warnings.
void ne;
void isNotNull;
