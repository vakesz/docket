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
import { errFields } from "@/server/log-fields";
import { logger } from "@/server/logger";
import { buildProviderForUser } from "@/server/providers/build";

type SyncPhase = "stream" | "persist" | "archive" | "cursor";
type SyncMode = "incremental" | "full";

export type SyncProgressStatus = "running" | "done" | "failed";

export type SyncProgressSnapshot = {
  runId: string;
  mode: SyncMode;
  status: SyncProgressStatus;
  phase: SyncPhase;
  startedAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  chunksCompleted: number;
  itemsSeen: number;
  upserted: number;
  archived: number;
  inboundConversations: number;
  commentsReconciled: number;
  watermark: Date | null;
  error: string | null;
};

type PersistedSyncProgressSnapshot = {
  runId: string;
  mode: SyncMode;
  status: SyncProgressStatus;
  phase: SyncPhase;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  chunksCompleted: number;
  itemsSeen: number;
  upserted: number;
  archived: number;
  inboundConversations: number;
  commentsReconciled: number;
  watermark: string | null;
  error: string | null;
};

type ProjectArg = Parameters<typeof buildProviderForUser>[1];

export type SyncResult = {
  upserted: number;
  archived: number;
  watermark: Date | null;
  /** Number of (active) conversations that received an inbound-change notice. */
  inboundConversations: number;
};

const SYNC_PROGRESS_KEY = "sync.progress";
const STALE_SYNC_PROGRESS_MS = 15 * 60 * 1000;
const CHUNK_SIZE = 200;
/**
 * Cap on concurrent chunk-persist tasks. With this > 1, fetching the next
 * page from the provider overlaps with persisting the previous chunk.
 * Kept low so we don't hammer the DB with parallel write transactions on
 * disjoint chunks; 2 is enough to hide one round-trip behind the other.
 */
const MAX_INFLIGHT_CHUNKS = 2;

function isSyncPhase(value: unknown): value is SyncPhase {
  return value === "stream" || value === "persist" || value === "archive" || value === "cursor";
}

function isSyncMode(value: unknown): value is SyncMode {
  return value === "incremental" || value === "full";
}

function isSyncProgressStatus(value: unknown): value is SyncProgressStatus {
  return value === "running" || value === "done" || value === "failed";
}

function toDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function encodeProgress(snapshot: SyncProgressSnapshot): string {
  const persisted: PersistedSyncProgressSnapshot = {
    runId: snapshot.runId,
    mode: snapshot.mode,
    status: snapshot.status,
    phase: snapshot.phase,
    startedAt: snapshot.startedAt.toISOString(),
    updatedAt: snapshot.updatedAt.toISOString(),
    finishedAt: snapshot.finishedAt ? snapshot.finishedAt.toISOString() : null,
    chunksCompleted: snapshot.chunksCompleted,
    itemsSeen: snapshot.itemsSeen,
    upserted: snapshot.upserted,
    archived: snapshot.archived,
    inboundConversations: snapshot.inboundConversations,
    commentsReconciled: snapshot.commentsReconciled,
    watermark: snapshot.watermark ? snapshot.watermark.toISOString() : null,
    error: snapshot.error,
  };
  return JSON.stringify(persisted);
}

function decodeProgress(raw: string | null): SyncProgressSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isSyncMode(parsed["mode"])) return null;
    if (!isSyncProgressStatus(parsed["status"])) return null;
    if (!isSyncPhase(parsed["phase"])) return null;
    if (typeof parsed["runId"] !== "string" || parsed["runId"].length === 0) return null;
    const startedAt = toDate(parsed["startedAt"]);
    const updatedAt = toDate(parsed["updatedAt"]);
    const finishedAt = parsed["finishedAt"] === null ? null : toDate(parsed["finishedAt"]);
    const watermark = parsed["watermark"] === null ? null : toDate(parsed["watermark"]);
    if (!startedAt || !updatedAt) return null;
    if (parsed["finishedAt"] !== null && !finishedAt) return null;
    if (parsed["watermark"] !== null && !watermark) return null;

    const readInt = (key: keyof PersistedSyncProgressSnapshot) => {
      const value = parsed[key];
      return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : 0;
    };

    return {
      runId: parsed["runId"],
      mode: parsed["mode"],
      status: parsed["status"],
      phase: parsed["phase"],
      startedAt,
      updatedAt,
      finishedAt,
      chunksCompleted: readInt("chunksCompleted"),
      itemsSeen: readInt("itemsSeen"),
      upserted: readInt("upserted"),
      archived: readInt("archived"),
      inboundConversations: readInt("inboundConversations"),
      commentsReconciled: readInt("commentsReconciled"),
      watermark,
      error: typeof parsed["error"] === "string" ? parsed["error"] : null,
    };
  } catch {
    return null;
  }
}

async function upsertProgress(
  db: typeof Db,
  projectId: string,
  snapshot: SyncProgressSnapshot,
): Promise<void> {
  // Resolves the existing row to either a no-op (existing belongs to a
  // strictly newer run) or an update; returns true if no row was found.
  // Same runId always passes: own-row writes (chunk updates, self-heal)
  // never trip the guard. Older/undecodable rows get taken over so a
  // brand-new run can replace a finished one.
  const tryUpdate = async (): Promise<boolean> => {
    const existing = await db.setting.findFirst({
      where: {
        key: SYNC_PROGRESS_KEY,
        scope: "project",
        projectId,
        userId: null,
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, value: true },
    });
    if (!existing) return false;
    const current = decodeProgress(existing.value);
    if (
      current &&
      current.runId !== snapshot.runId &&
      current.startedAt.getTime() > snapshot.startedAt.getTime()
    ) {
      return true;
    }
    await db.setting.update({
      where: { id: existing.id },
      data: { value: encodeProgress(snapshot) },
    });
    return true;
  };

  if (await tryUpdate()) return;

  try {
    await db.setting.create({
      data: {
        key: SYNC_PROGRESS_KEY,
        scope: "project",
        projectId,
        value: encodeProgress(snapshot),
      },
    });
  } catch (err) {
    // The partial unique on (key, projectId) for project-scope rows means
    // a concurrent first-write can race in between our findFirst and
    // create. Re-resolve through the update path so this run's progress
    // still lands.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      await tryUpdate();
      return;
    }
    throw err;
  }
}

export async function loadSyncProgress(
  db: typeof Db,
  projectId: string,
): Promise<SyncProgressSnapshot | null> {
  const row = await db.setting.findFirst({
    where: {
      key: SYNC_PROGRESS_KEY,
      scope: "project",
      projectId,
      userId: null,
    },
    orderBy: { updatedAt: "desc" },
    select: { value: true },
  });
  const snapshot = decodeProgress(row?.value ?? null);
  if (!snapshot) return null;

  if (
    snapshot.status === "running" &&
    Date.now() - snapshot.updatedAt.getTime() > STALE_SYNC_PROGRESS_MS
  ) {
    const failed: SyncProgressSnapshot = {
      ...snapshot,
      status: "failed",
      finishedAt: snapshot.finishedAt ?? new Date(),
      updatedAt: new Date(),
      error: snapshot.error ?? "Sync appears stale (no progress heartbeat).",
    };
    await upsertProgress(db, projectId, failed);
    return failed;
  }

  return snapshot;
}

export function toSyncProgressLabel(phase: SyncPhase): string {
  switch (phase) {
    case "stream":
      return "Streaming provider pages";
    case "persist":
      return "Persisting batches";
    case "archive":
      return "Archiving missing cached rows";
    case "cursor":
      return "Updating sync cursor";
  }
}

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

type UpsertProgressSnapshot = {
  upserted: number;
  inboundConversations: number;
  commentsReconciled: number;
  chunks: number;
  itemsSeen: number;
  latestUpdatedAt: Date | null;
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
  const toUpdate: {
    providerItemId: string;
    row: ReturnType<typeof toItemRow>;
  }[] = [];
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
    const created = await db.item.createMany({
      data: toCreate,
      skipDuplicates: true,
    });
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
    // Surrogates: existing rows already came back in `cachedMap` with their
    // ids — we only need a refetch for the freshly-created ones, since
    // `createMany` doesn't return them. Saves one full-chunk findMany on
    // every chunk where we've seen the items before (the common case after
    // the first sync).
    const surrogateMap = new Map<string, string>();
    for (const r of cachedRows) surrogateMap.set(r.providerItemId, r.id);
    const newIds = toCreate.map((r) => r.providerItemId).filter((id) => !surrogateMap.has(id));
    if (newIds.length > 0) {
      const newRows = await db.item.findMany({
        where: { projectId, providerItemId: { in: newIds } },
        select: { id: true, providerItemId: true },
      });
      for (const r of newRows) surrogateMap.set(r.providerItemId, r.id);
    }
    const reconcileBundles: CommentReconcileBundle[] = [];
    for (const b of bundlesWithComments) {
      const surrogate = surrogateMap.get(b.item.id);
      if (!surrogate) continue;
      reconcileBundles.push({ itemSurrogate: surrogate, comments: b.comments ?? [] });
    }
    commentsReconciled += await reconcileComments(db, reconcileBundles);
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
 * Reconcile cached comments against provider snapshots, batched over
 * arbitrary many items. One `findMany` covers every item in the call, then
 * per-comment upserts fan out in a single `Promise.all`. Skip-rewrite:
 * comments whose `providerUpdatedAt` matches the cached row (and whose body
 * matches) are left untouched. Returns the total number of writes.
 *
 * Deletions: not handled here. Providers don't reliably surface comment
 * deletions through their listing endpoints, and an over-eager delete would
 * silently erase user history. The next full refresh of the item can run a
 * stricter reconciliation if/when needed.
 */
export type CommentReconcileBundle = {
  itemSurrogate: string;
  comments: readonly CanonicalComment[];
};

export async function reconcileComments(
  db: typeof Db,
  bundles: readonly CommentReconcileBundle[],
): Promise<number> {
  const nonEmpty = bundles.filter((b) => b.comments.length > 0);
  if (nonEmpty.length === 0) return 0;
  const itemIds = nonEmpty.map((b) => b.itemSurrogate);
  const allExisting = await db.comment.findMany({
    where: { itemId: { in: itemIds } },
    select: { itemId: true, providerCommentId: true, providerUpdatedAt: true, bodyMd: true },
  });
  const byItem = new Map<string, Map<string, { providerUpdatedAt: Date | null; bodyMd: string }>>();
  for (const row of allExisting) {
    let slot = byItem.get(row.itemId);
    if (!slot) {
      slot = new Map();
      byItem.set(row.itemId, slot);
    }
    slot.set(row.providerCommentId, {
      providerUpdatedAt: row.providerUpdatedAt,
      bodyMd: row.bodyMd,
    });
  }
  const ops: Promise<unknown>[] = [];
  for (const { itemSurrogate, comments } of nonEmpty) {
    const existing = byItem.get(itemSurrogate);
    for (const c of comments) {
      const prev = existing?.get(c.id);
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
  onProgress?: (snapshot: UpsertProgressSnapshot) => Promise<void> | void,
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
    }).then(async (r) => {
      upserted += r.upserted;
      inboundConversations += r.inboundConversations;
      commentsReconciled += r.commentsReconciled;
      if (onProgress) {
        await onProgress({
          upserted,
          inboundConversations,
          commentsReconciled,
          chunks,
          itemsSeen: seenIds.size,
          latestUpdatedAt,
        });
      }
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

/**
 * One sync run. Both modes share the same envelope (progress journal,
 * baseCtx, error reporting); only three things differ:
 *
 *   - `mode: "incremental"` reads `SyncCursor.watermark` and asks the
 *     provider for changes after it; cursor bump leaves `lastFullSyncAt`
 *     alone (passed as `null` to `bumpCursor`).
 *   - `mode: "full"` ignores the watermark, then archives every cached row
 *     not seen during the walk and stamps `lastFullSyncAt = syncedAt`.
 *
 * Keeping the orchestration in one place means future cross-cutting
 * concerns (tracing, retry, watch hooks) only land in one spot.
 */
async function runSync(
  db: typeof Db,
  project: ProjectArg,
  userId: string,
  mode: SyncMode,
): Promise<SyncResult> {
  const syncId = randomUUID();
  const startedAt = Date.now();
  const runStartedAt = new Date(startedAt);
  const baseCtx = {
    syncId,
    mode,
    projectId: project.id,
    providerKind: project.providerKind,
    userId,
  };
  let phase: SyncPhase = "stream";
  let progress: SyncProgressSnapshot = {
    runId: syncId,
    mode,
    status: "running",
    phase,
    startedAt: runStartedAt,
    updatedAt: runStartedAt,
    finishedAt: null,
    chunksCompleted: 0,
    itemsSeen: 0,
    upserted: 0,
    archived: 0,
    inboundConversations: 0,
    commentsReconciled: 0,
    watermark: null,
    error: null,
  };

  const persistProgress = async () => {
    progress = { ...progress, updatedAt: new Date() };
    await upsertProgress(db, project.id, progress);
  };

  try {
    await persistProgress();

    const provider = await buildProviderForUser(db, project, userId);
    const syncedAt = new Date();
    const watermark =
      mode === "incremental"
        ? ((await db.syncCursor.findUnique({ where: { projectId: project.id } }))?.watermark ??
          null)
        : null;

    if (mode === "incremental") {
      progress = { ...progress, watermark };
      await persistProgress();
      logger.info({ ...baseCtx, watermark: watermark?.toISOString() ?? null }, "sync: start");
    } else {
      logger.info(baseCtx, "sync: start");
    }

    phase = "persist";
    progress = { ...progress, phase };
    await persistProgress();

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
      provider.listChangesSince(watermark),
      syncedAt,
      syncId,
      async (chunkProgress) => {
        progress = {
          ...progress,
          phase: "persist",
          chunksCompleted: chunkProgress.chunks,
          itemsSeen: chunkProgress.itemsSeen,
          upserted: chunkProgress.upserted,
          inboundConversations: chunkProgress.inboundConversations,
          commentsReconciled: chunkProgress.commentsReconciled,
          watermark:
            mode === "incremental"
              ? (chunkProgress.latestUpdatedAt ?? watermark)
              : chunkProgress.latestUpdatedAt,
        };
        await persistProgress();
      },
    );

    const newWatermark = mode === "incremental" ? (latestUpdatedAt ?? watermark) : latestUpdatedAt;

    let archived = 0;
    if (mode === "full") {
      // Archive any cached row not seen in the full walk. Excluding already-
      // archived rows keeps the update count meaningful.
      phase = "archive";
      progress = {
        ...progress,
        phase,
        chunksCompleted: chunks,
        itemsSeen,
        upserted,
        inboundConversations,
        commentsReconciled,
        watermark: newWatermark,
      };
      await persistProgress();

      const archive = await db.item.updateMany({
        where: {
          projectId: project.id,
          providerItemId: { notIn: Array.from(seenIds) },
          archived: false,
        },
        data: { archived: true },
      });
      archived = archive.count;
    }

    phase = "cursor";
    progress = {
      ...progress,
      phase,
      chunksCompleted: chunks,
      itemsSeen,
      upserted,
      inboundConversations,
      commentsReconciled,
      archived,
      watermark: newWatermark,
    };
    await persistProgress();

    await bumpCursor(db, project.id, newWatermark, mode === "full" ? syncedAt : null);

    progress = {
      ...progress,
      status: "done",
      phase,
      finishedAt: new Date(),
      archived,
      watermark: newWatermark,
      error: null,
    };
    await persistProgress();

    logger.info(
      {
        ...baseCtx,
        upserted,
        archived,
        chunks,
        itemsSeen,
        inboundConversations,
        commentsReconciled,
        newWatermark: newWatermark?.toISOString() ?? null,
        durationMs: Date.now() - startedAt,
      },
      "sync: done",
    );
    return {
      upserted,
      archived,
      watermark: newWatermark,
      inboundConversations,
    };
  } catch (err) {
    progress = {
      ...progress,
      status: "failed",
      phase,
      finishedAt: new Date(),
      error: err instanceof Error ? err.message : String(err),
    };
    await persistProgress();

    logger.error(
      {
        ...baseCtx,
        phase,
        durationMs: Date.now() - startedAt,
        ...errFields(err),
      },
      "sync: failed",
    );
    throw err;
  }
}

export function runIncrementalSync(
  db: typeof Db,
  project: ProjectArg,
  userId: string,
): Promise<SyncResult> {
  return runSync(db, project, userId, "incremental");
}

export function runFullSync(
  db: typeof Db,
  project: ProjectArg,
  userId: string,
): Promise<SyncResult> {
  return runSync(db, project, userId, "full");
}
