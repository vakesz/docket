/**
 * Project sync — pulls items from the project's provider into the cache.
 *
 * Two modes:
 *   - `runIncrementalSync` uses the project's `SyncCursor.watermark` and
 *     fetches only items updated after it. Cheap; safe to run often.
 *   - `runFullSync` ignores the watermark and walks the full result set,
 *     then archives any cached row not seen in the walk. The archive step
 *     is what makes "issue closed at the provider but never re-synced"
 *     observable.
 *
 * Both routes update `SyncCursor`. `lastFullSyncAt` is only stamped by
 * `runFullSync`; `watermark` is bumped by both to the most recent
 * `updatedAt` we observed.
 *
 * Items are drained from the provider's async iterable in chunks
 * (`CHUNK_SIZE`) and persisted in bulk: one `findMany` per chunk to load
 * the existing rows, `createMany` for new ids, and a single
 * `$transaction` of `update`s for existing ids. On large repos this turns
 * thousands of sequential per-item round-trips into a handful of pipelined
 * batches — the dominant sync cost on first-time / full syncs.
 */

import "server-only";
import { randomUUID } from "node:crypto";
import type { Comment as CanonicalComment, Item as CanonicalItem, ChangedItem } from "@/core/types";
import { Prisma } from "@/db/generated/client";
import { warmAvatars } from "@/server/avatars/service";
import type { db as Db } from "@/server/db";
import {
  injectExternalChange,
  type MaterialChange,
  materialDiff,
} from "@/server/inbound-changes/inject";
import { logger } from "@/server/logger";
import { buildProviderForUser } from "@/server/providers/build";

type SyncPhase = "stream" | "persist" | "archive" | "cursor";

function errFields(err: unknown): { err: string; stack?: string } {
  if (err instanceof Error) {
    return { err: err.message, stack: err.stack };
  }
  return { err: String(err) };
}

type ProjectArg = Parameters<typeof buildProviderForUser>[1];

export type SyncResult = {
  upserted: number;
  archived: number;
  watermark: Date | null;
  /** Number of (active) conversations that received an inbound-change notice. */
  inboundConversations: number;
};

const CHUNK_SIZE = 200;
/**
 * Cap on concurrent chunk-persist tasks. With this > 1, fetching the next
 * page from the provider overlaps with persisting the previous chunk.
 * Kept low so we don't hammer the DB with parallel write transactions on
 * disjoint chunks; 2 is enough to hide one round-trip behind the other.
 */
const MAX_INFLIGHT_CHUNKS = 2;

export function toItemRow(canonical: CanonicalItem, projectId: string, syncedAt: Date) {
  // The plural assignee column always reflects the singular: providers
  // without multi-assignee surface a single login through `assignee`, and
  // we want both columns coherent so callers can transition reads at their
  // own pace.
  const assignees = canonical.assignees ?? (canonical.assignee ? [canonical.assignee] : []);
  return {
    projectId,
    providerItemId: canonical.id,
    kind: canonical.kind,
    title: canonical.title,
    descriptionMd: canonical.descriptionMd,
    state: canonical.state,
    assignee: canonical.assignee,
    assignees,
    reviewers: canonical.reviewers ?? [],
    linkedItemIds: canonical.linkedItemIds ?? [],
    author: canonical.author,
    parentId: canonical.parentId,
    tags: canonical.tags,
    providerRaw: canonical.providerRaw as Prisma.InputJsonValue,
    url: canonical.url,
    repositoryUrl: canonical.repositoryUrl,
    createdAt: canonical.createdAt,
    updatedAt: canonical.updatedAt ?? syncedAt,
    closedAt: canonical.closedAt ?? null,
    syncedAt,
    archived: false,
    reactions: (canonical.reactions ?? Prisma.JsonNull) as
      | Prisma.InputJsonValue
      | typeof Prisma.JsonNull,
    milestone: canonical.milestone ?? null,
    iteration: canonical.iteration ?? null,
    area: canonical.area ?? null,
    ciSummary: (canonical.ciSummary ?? Prisma.JsonNull) as
      | Prisma.InputJsonValue
      | typeof Prisma.JsonNull,
  };
}

type ChunkResult = {
  upserted: number;
  inboundConversations: number;
  commentsReconciled: number;
};

/**
 * Persist a chunk of bundled changes (item + optional comments): bulk-load
 * existing item rows, split into create/update sets, then write each set
 * in one DB call. Material diffs for already-cached items fan out into
 * `injectExternalChange` in parallel — new items have no prior conversation
 * context so they skip the inject step entirely. Once items are persisted
 * (and surrogate ids known), comment bundles where `comments !== null`
 * reconcile against the cache with a per-comment skip-rewrite.
 */
async function processChunk(
  db: typeof Db,
  projectId: string,
  bundles: readonly ChangedItem[],
  syncedAt: Date,
  ctx: { syncId: string; chunkIndex: number; providerKind: string },
): Promise<ChunkResult> {
  const startedAt = Date.now();
  const ids = bundles.map((b) => b.item.id);
  const cachedRows = await db.item.findMany({
    where: { projectId, providerItemId: { in: ids } },
    select: {
      id: true,
      providerItemId: true,
      state: true,
      title: true,
      descriptionMd: true,
      assignee: true,
    },
  });
  const cachedMap = new Map(cachedRows.map((r) => [r.providerItemId, r]));

  const toCreate: ReturnType<typeof toItemRow>[] = [];
  const toUpdate: { providerItemId: string; row: ReturnType<typeof toItemRow> }[] = [];
  const changedExisting: {
    itemId: string;
    providerItemId: string;
    changes: MaterialChange[];
  }[] = [];

  for (const bundle of bundles) {
    const item = bundle.item;
    const row = toItemRow(item, projectId, syncedAt);
    const cached = cachedMap.get(item.id);
    if (cached) {
      toUpdate.push({ providerItemId: item.id, row });
      const changes = materialDiff(cached, item);
      if (changes.length > 0) {
        changedExisting.push({
          itemId: cached.id,
          providerItemId: item.id,
          changes,
        });
      }
    } else {
      toCreate.push(row);
    }
  }

  let upserted = 0;
  if (toCreate.length > 0) {
    // skipDuplicates guards against a concurrent insert sneaking in
    // between the findMany above and this createMany.
    const created = await db.item.createMany({ data: toCreate, skipDuplicates: true });
    upserted += created.count;
  }
  if (toUpdate.length > 0) {
    await db.$transaction(
      toUpdate.map(({ providerItemId, row }) =>
        db.item.update({
          where: { projectId_providerItemId: { projectId, providerItemId } },
          data: { ...row, archived: false },
          select: { id: true },
        }),
      ),
    );
    upserted += toUpdate.length;
  }

  let inboundConversations = 0;
  if (changedExisting.length > 0) {
    const results = await Promise.all(
      changedExisting.map((c) =>
        injectExternalChange(db, {
          projectId,
          itemId: c.itemId,
          providerItemId: c.providerItemId,
          changes: c.changes,
        }),
      ),
    );
    for (const r of results) inboundConversations += r.injectedInto;
  }

  let commentsReconciled = 0;
  const bundlesWithComments = bundles.filter((b) => b.comments !== null);
  if (bundlesWithComments.length > 0) {
    // Re-fetch the surrogate ids: createMany doesn't return them, and the
    // first findMany only saw the rows that already existed.
    const surrogateRows = await db.item.findMany({
      where: { projectId, providerItemId: { in: ids } },
      select: { id: true, providerItemId: true },
    });
    const surrogateMap = new Map(surrogateRows.map((r) => [r.providerItemId, r.id]));
    const results = await Promise.all(
      bundlesWithComments.map(async (b) => {
        const surrogate = surrogateMap.get(b.item.id);
        if (!surrogate) return 0;
        const comments = b.comments ?? [];
        return reconcileComments(db, surrogate, comments);
      }),
    );
    for (const n of results) commentsReconciled += n;
  }

  // Warm the avatar cache for assignees in this chunk so the first item-
  // list render after sync has bytes ready instead of flickering through
  // the lazy-fetch path. Best-effort + fire-and-forget — sync should never
  // fail because an avatar fetch did, and the loop itself bounds
  // concurrency internally.
  const assignees = collectAssignees(bundles);
  if (assignees.length > 0) {
    void warmAvatars(db, {
      providerKind: ctx.providerKind,
      identifiers: assignees,
    }).catch((err) => {
      logger.warn(
        {
          syncId: ctx.syncId,
          projectId,
          chunkIndex: ctx.chunkIndex,
          err: err instanceof Error ? err.message : String(err),
        },
        "sync: avatar warm failed",
      );
    });
  }

  logger.debug(
    {
      syncId: ctx.syncId,
      projectId,
      chunkIndex: ctx.chunkIndex,
      size: bundles.length,
      created: toCreate.length,
      updated: toUpdate.length,
      materialChanges: changedExisting.length,
      inboundConversations,
      commentsReconciled,
      chunkMs: Date.now() - startedAt,
    },
    "sync: chunk persisted",
  );

  return { upserted, inboundConversations, commentsReconciled };
}

function collectAssignees(bundles: readonly ChangedItem[]): string[] {
  const set = new Set<string>();
  for (const bundle of bundles) {
    const item = bundle.item;
    if (item.assignee) set.add(item.assignee);
    for (const a of item.assignees ?? []) {
      if (a) set.add(a);
    }
  }
  return Array.from(set);
}

/**
 * Reconcile cached comments for a single item against the provider snapshot.
 * Skip-rewrite: comments whose `providerUpdatedAt` matches the cached row
 * (and whose body matches) are left untouched. Returns the number of writes.
 *
 * Deletions: not handled here. Providers don't reliably surface comment
 * deletions through their listing endpoints, and an over-eager delete would
 * silently erase user history. The next full refresh of the item can run a
 * stricter reconciliation if/when needed.
 */
export async function reconcileComments(
  db: typeof Db,
  itemSurrogate: string,
  comments: readonly CanonicalComment[],
): Promise<number> {
  if (comments.length === 0) return 0;
  const existing = await db.comment.findMany({
    where: { itemId: itemSurrogate },
    select: { providerCommentId: true, providerUpdatedAt: true, bodyMd: true },
  });
  const existingMap = new Map(existing.map((e) => [e.providerCommentId, e]));
  const ops: Promise<unknown>[] = [];
  for (const c of comments) {
    const prev = existingMap.get(c.id);
    const incomingPu = c.updatedAt ?? null;
    const reactions = (c.reactions ?? Prisma.JsonNull) as
      | Prisma.InputJsonValue
      | typeof Prisma.JsonNull;
    if (prev) {
      const prevMs = prev.providerUpdatedAt?.getTime() ?? null;
      const incMs = incomingPu?.getTime() ?? null;
      if (prevMs === incMs && prev.bodyMd === c.bodyMd) continue;
    }
    ops.push(
      db.comment.upsert({
        where: {
          itemId_providerCommentId: {
            itemId: itemSurrogate,
            providerCommentId: c.id,
          },
        },
        create: {
          itemId: itemSurrogate,
          providerCommentId: c.id,
          author: c.author,
          bodyMd: c.bodyMd,
          createdAt: c.createdAt,
          providerUpdatedAt: incomingPu,
          edited: c.edited ?? false,
          reactions,
        },
        update: {
          author: c.author,
          bodyMd: c.bodyMd,
          createdAt: c.createdAt,
          providerUpdatedAt: incomingPu,
          edited: c.edited ?? false,
          reactions,
        },
      }),
    );
  }
  if (ops.length === 0) return 0;
  await Promise.all(ops);
  return ops.length;
}

async function upsertItems(
  db: typeof Db,
  projectId: string,
  providerKind: string,
  bundles: AsyncIterable<ChangedItem>,
  syncedAt: Date,
  syncId: string,
): Promise<{
  upserted: number;
  seenIds: Set<string>;
  latestUpdatedAt: Date | null;
  inboundConversations: number;
  commentsReconciled: number;
  chunks: number;
  itemsSeen: number;
}> {
  let upserted = 0;
  let latestUpdatedAt: Date | null = null;
  let inboundConversations = 0;
  let commentsReconciled = 0;
  let chunks = 0;
  const seenIds = new Set<string>();
  let buffer: ChangedItem[] = [];
  const inflight = new Set<Promise<void>>();
  let firstItemAt: number | null = null;
  const streamStartedAt = Date.now();

  const fire = (chunk: readonly ChangedItem[]) => {
    const chunkIndex = chunks++;
    const task = processChunk(db, projectId, chunk, syncedAt, {
      syncId,
      chunkIndex,
      providerKind,
    }).then((r) => {
      upserted += r.upserted;
      inboundConversations += r.inboundConversations;
      commentsReconciled += r.commentsReconciled;
    });
    const tracked = task.finally(() => {
      inflight.delete(tracked);
    });
    inflight.add(tracked);
    return tracked;
  };

  for await (const bundle of bundles) {
    const item = bundle.item;
    if (firstItemAt === null) {
      firstItemAt = Date.now();
      logger.debug(
        {
          syncId,
          projectId,
          firstItemMs: firstItemAt - streamStartedAt,
        },
        "sync: provider stream first item",
      );
    }
    buffer.push(bundle);
    seenIds.add(item.id);
    if (item.updatedAt && (!latestUpdatedAt || item.updatedAt > latestUpdatedAt)) {
      latestUpdatedAt = item.updatedAt;
    }
    if (buffer.length >= CHUNK_SIZE) {
      const chunk = buffer;
      buffer = [];
      fire(chunk);
      // Bound the number of in-flight chunks so we hide one DB round-trip
      // behind the next provider-page fetch without spawning unbounded
      // parallel write transactions.
      while (inflight.size >= MAX_INFLIGHT_CHUNKS) {
        await Promise.race(inflight);
      }
    }
  }
  if (buffer.length > 0) {
    fire(buffer);
    buffer = [];
  }
  await Promise.all(inflight);

  return {
    upserted,
    seenIds,
    latestUpdatedAt,
    inboundConversations,
    commentsReconciled,
    chunks,
    itemsSeen: seenIds.size,
  };
}

async function bumpCursor(
  db: typeof Db,
  projectId: string,
  watermark: Date | null,
  fullSyncAt: Date | null,
): Promise<void> {
  await db.syncCursor.upsert({
    where: { projectId },
    create: {
      projectId,
      watermark,
      lastFullSyncAt: fullSyncAt,
    },
    update: {
      ...(watermark ? { watermark } : {}),
      ...(fullSyncAt ? { lastFullSyncAt: fullSyncAt } : {}),
    },
  });
}

export async function runIncrementalSync(
  db: typeof Db,
  project: ProjectArg,
  userId: string,
): Promise<SyncResult> {
  const syncId = randomUUID();
  const startedAt = Date.now();
  const baseCtx = {
    syncId,
    mode: "incremental" as const,
    projectId: project.id,
    providerKind: project.providerKind,
    userId,
  };
  let phase: SyncPhase = "stream";
  try {
    const provider = await buildProviderForUser(db, project, userId);
    const cursor = await db.syncCursor.findUnique({ where: { projectId: project.id } });
    const watermark = cursor?.watermark ?? null;
    const syncedAt = new Date();

    logger.info({ ...baseCtx, watermark: watermark?.toISOString() ?? null }, "sync: start");

    phase = "persist";
    const {
      upserted,
      latestUpdatedAt,
      inboundConversations,
      commentsReconciled,
      chunks,
      itemsSeen,
    } = await upsertItems(
      db,
      project.id,
      project.providerKind,
      provider.listChangesSince(watermark),
      syncedAt,
      syncId,
    );

    phase = "cursor";
    const newWatermark = latestUpdatedAt ?? watermark;
    await bumpCursor(db, project.id, newWatermark, null);

    logger.info(
      {
        ...baseCtx,
        upserted,
        archived: 0,
        chunks,
        itemsSeen,
        inboundConversations,
        commentsReconciled,
        newWatermark: newWatermark?.toISOString() ?? null,
        durationMs: Date.now() - startedAt,
      },
      "sync: done",
    );
    return { upserted, archived: 0, watermark: newWatermark, inboundConversations };
  } catch (err) {
    logger.error(
      { ...baseCtx, phase, durationMs: Date.now() - startedAt, ...errFields(err) },
      "sync: failed",
    );
    throw err;
  }
}

export async function runFullSync(
  db: typeof Db,
  project: ProjectArg,
  userId: string,
): Promise<SyncResult> {
  const syncId = randomUUID();
  const startedAt = Date.now();
  const baseCtx = {
    syncId,
    mode: "full" as const,
    projectId: project.id,
    providerKind: project.providerKind,
    userId,
  };
  let phase: SyncPhase = "stream";
  try {
    const provider = await buildProviderForUser(db, project, userId);
    const syncedAt = new Date();

    logger.info(baseCtx, "sync: start");

    phase = "persist";
    const {
      upserted,
      seenIds,
      latestUpdatedAt,
      inboundConversations,
      commentsReconciled,
      chunks,
      itemsSeen,
    } = await upsertItems(
      db,
      project.id,
      project.providerKind,
      provider.listChangesSince(null),
      syncedAt,
      syncId,
    );

    // Archive any cached row not seen in the full walk. Excluding already-
    // archived rows keeps the update count meaningful.
    phase = "archive";
    const archive = await db.item.updateMany({
      where: {
        projectId: project.id,
        providerItemId: { notIn: Array.from(seenIds) },
        archived: false,
      },
      data: { archived: true },
    });

    phase = "cursor";
    await bumpCursor(db, project.id, latestUpdatedAt, syncedAt);

    logger.info(
      {
        ...baseCtx,
        upserted,
        archived: archive.count,
        chunks,
        itemsSeen,
        inboundConversations,
        commentsReconciled,
        newWatermark: latestUpdatedAt?.toISOString() ?? null,
        durationMs: Date.now() - startedAt,
      },
      "sync: done",
    );
    return {
      upserted,
      archived: archive.count,
      watermark: latestUpdatedAt,
      inboundConversations,
    };
  } catch (err) {
    logger.error(
      { ...baseCtx, phase, durationMs: Date.now() - startedAt, ...errFields(err) },
      "sync: failed",
    );
    throw err;
  }
}
