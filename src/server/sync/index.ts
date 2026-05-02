// `runFullSync` archives any cached row not seen in the walk — that's
// what makes "closed at the provider but never re-synced" observable.
// Items are drained in `CHUNK_SIZE` batches: one findMany per chunk to
// load existing rows, drizzle insert for new ids, then a parallel set
// of updates — bulk pipelining beats thousands of sequential round-trips
// on first-time / full syncs.

import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  asProjectId,
  asProviderItemId,
  type Comment as CanonicalComment,
  type Item as CanonicalItem,
  type ChangedItem,
  type ItemId,
  type ProjectId,
  type ProviderItemId,
  type UserId,
} from "@/core/types";
import type { Db, DbTx } from "@/db";
import { comments, items, settings, syncCursors } from "@/db/schema";
import { warmAvatars } from "@/server/avatars/service";
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

// Single source of truth for the persisted snapshot shape: zod parses the
// raw JSON, validates string enums, coerces ISO date strings to Date, and
// clamps counters to non-negative integers. The previous hand-rolled type
// guards drifted from `PersistedSyncProgressSnapshot` whenever a field was
// added; with the schema, runtime validation and the inferred type can't.
const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(new Date(s).getTime()), { message: "invalid ISO date" })
  .transform((s) => new Date(s));

const nonNegInt = z
  .number()
  .finite()
  .transform((n) => Math.max(0, Math.floor(n)))
  .catch(0);

const PersistedSyncProgressSchema = z.object({
  runId: z.string().min(1),
  mode: z.enum(["incremental", "full"]),
  status: z.enum(["running", "done", "failed"]),
  phase: z.enum(["stream", "persist", "archive", "cursor"]),
  startedAt: isoDate,
  updatedAt: isoDate,
  finishedAt: z.union([z.null(), isoDate]),
  chunksCompleted: nonNegInt,
  itemsSeen: nonNegInt,
  upserted: nonNegInt,
  archived: nonNegInt,
  inboundConversations: nonNegInt,
  commentsReconciled: nonNegInt,
  watermark: z.union([z.null(), isoDate]),
  error: z.string().nullable().catch(null),
});

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

function decodeProgress(raw: string | null | undefined): SyncProgressSnapshot | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = PersistedSyncProgressSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

async function upsertProgress(
  db: Db,
  projectId: ProjectId,
  snapshot: SyncProgressSnapshot,
): Promise<void> {
  // Resolves the existing row to either a no-op (existing belongs to a
  // strictly newer run) or an update; falls through to insert if no row was
  // found. Same runId always passes: own-row writes (chunk updates,
  // self-heal) never trip the guard. Older/undecodable rows get taken over
  // so a brand-new run can replace a finished one.
  const existing = await db.query.settings.findFirst({
    where: and(
      eq(settings.key, SYNC_PROGRESS_KEY),
      eq(settings.scope, "project"),
      eq(settings.projectId, projectId),
    ),
    orderBy: (s, { desc }) => [desc(s.updatedAt)],
    columns: { id: true, value: true },
  });
  const encoded = encodeProgress(snapshot);
  if (existing) {
    const current = decodeProgress(existing.value);
    if (
      current &&
      current.runId !== snapshot.runId &&
      current.startedAt.getTime() > snapshot.startedAt.getTime()
    ) {
      return;
    }
    await db
      .update(settings)
      .set({ value: encoded, updatedAt: new Date() })
      .where(eq(settings.id, existing.id));
    return;
  }
  // Race-safe: if a concurrent first-write inserted between findFirst and
  // here, the partial unique on (key, projectId) for project-scope rows
  // raises 23505. Catch it and re-resolve through the update path so this
  // run's progress still lands.
  try {
    await db.insert(settings).values({
      key: SYNC_PROGRESS_KEY,
      scope: "project",
      projectId,
      value: encoded,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const retry = await db.query.settings.findFirst({
        where: and(
          eq(settings.key, SYNC_PROGRESS_KEY),
          eq(settings.scope, "project"),
          eq(settings.projectId, projectId),
        ),
        columns: { id: true },
      });
      if (retry) {
        await db
          .update(settings)
          .set({ value: encoded, updatedAt: new Date() })
          .where(eq(settings.id, retry.id));
      }
      return;
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

export async function loadSyncProgress(
  db: Db,
  projectId: ProjectId,
): Promise<SyncProgressSnapshot | null> {
  const row = await db.query.settings.findFirst({
    where: and(
      eq(settings.key, SYNC_PROGRESS_KEY),
      eq(settings.scope, "project"),
      eq(settings.projectId, projectId),
    ),
    orderBy: (s, { desc }) => [desc(s.updatedAt)],
    columns: { value: true },
  });
  const snapshot = decodeProgress(row?.value);
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

export type ItemRow = {
  projectId: ProjectId;
  providerItemId: ProviderItemId;
  kind: CanonicalItem["kind"];
  title: string;
  description: string;
  state: CanonicalItem["state"];
  assignees: string[];
  reviewers: string[];
  linkedItemIds: string[];
  author: string | null;
  parentId: ProviderItemId | null;
  tags: string[];
  providerRaw: Record<string, unknown>;
  url: string | null;
  repositoryUrl: string | null;
  createdAt: Date | null;
  updatedAt: Date;
  closedAt: Date | null;
  syncedAt: Date;
  archived: boolean;
  reactions: CanonicalItem["reactions"] | null;
  milestone: string | null;
  iteration: string | null;
  area: string | null;
  ciSummary: CanonicalItem["ciSummary"] | null;
};

export function toItemRow(canonical: CanonicalItem, projectId: ProjectId, syncedAt: Date): ItemRow {
  const assignees = canonical.assignees ?? (canonical.assignee ? [canonical.assignee] : []);
  return {
    projectId,
    providerItemId: asProviderItemId(canonical.id),
    kind: canonical.kind,
    title: canonical.title,
    description: canonical.description,
    state: canonical.state,
    assignees: [...assignees],
    reviewers: [...(canonical.reviewers ?? [])],
    linkedItemIds: [...(canonical.linkedItemIds ?? [])],
    author: canonical.author ?? null,
    parentId: canonical.parentId ? asProviderItemId(canonical.parentId) : null,
    tags: [...canonical.tags],
    providerRaw: canonical.providerRaw as Record<string, unknown>,
    url: canonical.url ?? null,
    repositoryUrl: canonical.repositoryUrl ?? null,
    createdAt: canonical.createdAt ?? null,
    updatedAt: canonical.updatedAt ?? syncedAt,
    closedAt: canonical.closedAt ?? null,
    syncedAt,
    archived: false,
    reactions: canonical.reactions ?? null,
    milestone: canonical.milestone ?? null,
    iteration: canonical.iteration ?? null,
    area: canonical.area ?? null,
    ciSummary: canonical.ciSummary ?? null,
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
  db: Db,
  projectId: ProjectId,
  bundles: readonly ChangedItem[],
  syncedAt: Date,
  ctx: { syncId: string; chunkIndex: number; providerKind: string },
): Promise<ChunkResult> {
  const startedAt = Date.now();
  const ids = bundles.map((b) => asProviderItemId(b.item.id));
  const cachedRows = await db
    .select({
      id: items.id,
      providerItemId: items.providerItemId,
      state: items.state,
      title: items.title,
      description: items.description,
      assignees: items.assignees,
    })
    .from(items)
    .where(and(eq(items.projectId, projectId), inArray(items.providerItemId, ids)));
  const cachedMap = new Map(cachedRows.map((r) => [r.providerItemId, r]));

  const toCreate: ItemRow[] = [];
  const toUpdate: { providerItemId: ProviderItemId; row: ItemRow }[] = [];
  const changedExisting: {
    itemId: ItemId;
    providerItemId: ProviderItemId;
    changes: MaterialChange[];
  }[] = [];

  for (const bundle of bundles) {
    const item = bundle.item;
    const providerItemId = asProviderItemId(item.id);
    const row = toItemRow(item, projectId, syncedAt);
    const cached = cachedMap.get(providerItemId);
    if (cached) {
      toUpdate.push({ providerItemId, row });
      const changes = materialDiff(cached, item);
      if (changes.length > 0) {
        changedExisting.push({
          itemId: cached.id,
          providerItemId,
          changes,
        });
      }
    } else {
      toCreate.push(row);
    }
  }

  let upserted = 0;
  if (toCreate.length > 0) {
    // onConflictDoNothing guards against a concurrent insert sneaking in
    // between the select above and this insert.
    const inserted = await db
      .insert(items)
      .values(toCreate)
      .onConflictDoNothing({
        target: [items.projectId, items.providerItemId],
      })
      .returning({ id: items.id });
    upserted += inserted.length;
  }
  if (toUpdate.length > 0) {
    // Each item update is independent — a partial failure leaves the cache
    // out of date for that row, which the next sync cycle reconciles.
    // Promise.all hands them all to the pg pool and lets it pipeline.
    // MAX_INFLIGHT_CHUNKS keeps overall fan-out bounded.
    await Promise.all(
      toUpdate.map(({ providerItemId, row }) =>
        db
          .update(items)
          .set({ ...row, archived: false })
          .where(and(eq(items.projectId, projectId), eq(items.providerItemId, providerItemId))),
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
    // ids — we only need a refetch for the freshly-created ones, since the
    // batched insert above doesn't return id-by-providerItemId. Saves one
    // full-chunk select on every chunk where we've seen the items before
    // (the common case after the first sync).
    const surrogateMap = new Map<string, ItemId>();
    for (const r of cachedRows) surrogateMap.set(r.providerItemId, r.id);
    const newIds = toCreate.map((r) => r.providerItemId).filter((id) => !surrogateMap.has(id));
    if (newIds.length > 0) {
      const newRows = await db
        .select({ id: items.id, providerItemId: items.providerItemId })
        .from(items)
        .where(and(eq(items.projectId, projectId), inArray(items.providerItemId, newIds)));
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
  const assigneeLogins = collectAssignees(bundles);
  if (assigneeLogins.length > 0) {
    void warmAvatars(db, {
      providerKind: ctx.providerKind,
      identifiers: assigneeLogins,
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
 * arbitrary many items. One select covers every item in the call, then
 * per-comment writes fan out in a single `Promise.all`. Skip-rewrite:
 * comments whose `providerUpdatedAt` matches the cached row (and whose body
 * matches) are left untouched. Returns the total number of writes.
 *
 * Deletions: not handled here. Providers don't reliably surface comment
 * deletions through their listing endpoints, and an over-eager delete would
 * silently erase user history. The next full refresh of the item can run a
 * stricter reconciliation if/when needed.
 */
export type CommentReconcileBundle = {
  itemSurrogate: ItemId;
  comments: readonly CanonicalComment[];
};

type CommentInsertRow = typeof comments.$inferInsert;

export async function reconcileComments(
  db: Db | DbTx,
  bundles: readonly CommentReconcileBundle[],
): Promise<number> {
  const nonEmpty = bundles.filter((b) => b.comments.length > 0);
  if (nonEmpty.length === 0) return 0;
  const itemIds = nonEmpty.map((b) => b.itemSurrogate);
  const allExisting = await db
    .select({
      itemId: comments.itemId,
      providerCommentId: comments.providerCommentId,
      providerUpdatedAt: comments.providerUpdatedAt,
      body: comments.body,
    })
    .from(comments)
    .where(inArray(comments.itemId, itemIds));
  const byItem = new Map<ItemId, Map<string, { providerUpdatedAt: Date | null; body: string }>>();
  for (const row of allExisting) {
    let slot = byItem.get(row.itemId);
    if (!slot) {
      slot = new Map();
      byItem.set(row.itemId, slot);
    }
    slot.set(row.providerCommentId, {
      providerUpdatedAt: row.providerUpdatedAt,
      body: row.body,
    });
  }
  // Split into "new rows" (one batched insert) and "changed rows" (per-row
  // updates in parallel). Avoids N upserts on the typical first-sync case
  // where every comment is new.
  const inserts: CommentInsertRow[] = [];
  const updates: Promise<unknown>[] = [];
  let touched = 0;
  for (const { itemSurrogate, comments: incomingComments } of nonEmpty) {
    const existing = byItem.get(itemSurrogate);
    for (const c of incomingComments) {
      const prev = existing?.get(c.id);
      const incomingPu = c.updatedAt ?? null;
      const reactions = c.reactions ?? null;
      if (prev) {
        const prevMs = prev.providerUpdatedAt?.getTime() ?? null;
        const incMs = incomingPu?.getTime() ?? null;
        if (prevMs === incMs && prev.body === c.body) continue;
        updates.push(
          db
            .update(comments)
            .set({
              author: c.author,
              body: c.body,
              createdAt: c.createdAt,
              providerUpdatedAt: incomingPu,
              edited: c.edited ?? false,
              reactions,
            })
            .where(and(eq(comments.itemId, itemSurrogate), eq(comments.providerCommentId, c.id))),
        );
        touched++;
      } else {
        inserts.push({
          itemId: itemSurrogate,
          providerCommentId: c.id,
          author: c.author,
          body: c.body,
          createdAt: c.createdAt,
          providerUpdatedAt: incomingPu,
          edited: c.edited ?? false,
          reactions,
        });
        touched++;
      }
    }
  }
  if (touched === 0) return 0;
  await Promise.all([
    inserts.length > 0
      ? db
          .insert(comments)
          .values(inserts)
          .onConflictDoNothing({ target: [comments.itemId, comments.providerCommentId] })
      : Promise.resolve(),
    ...updates,
  ]);
  return touched;
}

async function upsertItems(
  db: Db,
  projectId: ProjectId,
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
  db: Db,
  projectId: ProjectId,
  watermark: Date | null,
  fullSyncAt: Date | null,
): Promise<void> {
  await db
    .insert(syncCursors)
    .values({
      projectId,
      watermark,
      lastFullSyncAt: fullSyncAt,
    })
    .onConflictDoUpdate({
      target: syncCursors.projectId,
      set: {
        ...(watermark ? { watermark } : {}),
        ...(fullSyncAt ? { lastFullSyncAt: fullSyncAt } : {}),
      },
    });
}

/**
 * One sync run. Both modes share the same envelope (progress journal,
 * baseCtx, error reporting); only three things differ:
 *
 *   - `mode: "incremental"` reads `syncCursors.watermark` and asks the
 *     provider for changes after it; cursor bump leaves `lastFullSyncAt`
 *     alone (passed as `null` to `bumpCursor`).
 *   - `mode: "full"` ignores the watermark, then archives every cached row
 *     not seen during the walk and stamps `lastFullSyncAt = syncedAt`.
 *
 * Keeping the orchestration in one place means future cross-cutting
 * concerns (tracing, retry, watch hooks) only land in one spot.
 */
async function runSync(
  db: Db,
  project: ProjectArg,
  userId: UserId,
  mode: SyncMode,
): Promise<SyncResult> {
  const projectId = asProjectId(project.id);
  const syncId = randomUUID();
  const startedAt = Date.now();
  const runStartedAt = new Date(startedAt);
  const baseCtx = {
    syncId,
    mode,
    projectId,
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
    await upsertProgress(db, projectId, progress);
  };

  try {
    await persistProgress();

    const provider = await buildProviderForUser(db, project, userId);
    const syncedAt = new Date();
    const cursorRow =
      mode === "incremental"
        ? await db.query.syncCursors.findFirst({
            where: eq(syncCursors.projectId, projectId),
            columns: { watermark: true },
          })
        : null;
    const watermark = mode === "incremental" ? (cursorRow?.watermark ?? null) : null;

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
      projectId,
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

      // Single-array binding via `<> ALL($1::text[])` keeps the parameter
      // count constant regardless of `seenIds` cardinality — a positional-
      // parameter `notIn` would fan out to N positional parameters and trip
      // Postgres's 65K parameter limit on full syncs of large repos.
      // `sql.param` is required: a bare `${seenArr}` interpolation expands
      // the JS array into a tuple `($4,$5,...)` which Postgres can't cast
      // to `text[]`, so the whole update fails.
      const seenArr = Array.from(seenIds);
      const archived_ids = await db
        .update(items)
        .set({ archived: true })
        .where(
          and(
            eq(items.projectId, projectId),
            eq(items.archived, false),
            sql`${items.providerItemId} <> ALL(${sql.param(seenArr)}::text[])`,
          ),
        )
        .returning({ id: items.id });
      archived = archived_ids.length;
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

    await bumpCursor(db, projectId, newWatermark, mode === "full" ? syncedAt : null);

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
  db: Db,
  project: ProjectArg,
  userId: UserId,
): Promise<SyncResult> {
  return runSync(db, project, userId, "incremental");
}

export function runFullSync(db: Db, project: ProjectArg, userId: UserId): Promise<SyncResult> {
  return runSync(db, project, userId, "full");
}
