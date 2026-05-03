// `runFullSync` archives any cached row not seen in the walk — that's
// what makes "closed at the provider but never re-synced" observable.
// Items are drained in `tunables.chunkSize` batches: one findMany per
// chunk to load existing rows, drizzle insert for new ids, then a
// parallel set of updates — bulk pipelining beats thousands of
// sequential round-trips on first-time / full syncs.

import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type {
  Comment as CanonicalComment,
  Item as CanonicalItem,
  ChangedItem,
  ItemId,
  ProjectId,
  ProviderItemId,
  UserId,
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
import { loadGlobalSetting } from "@/server/settings/effective";

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
  failedItems: number;
  failedComments: number;
  warnings: string[];
  watermark: Date | null;
  error: string | null;
};

// Bumped when the persisted JSON shape changes. The parser defaults
// missing/older versions to 1 so pre-existing rows still load cleanly;
// future bumps can branch a migrate-up step on this value before
// validating against the current schema.
const CURRENT_SNAPSHOT_VERSION = 1 as const;

type PersistedSyncProgressSnapshot = {
  version: typeof CURRENT_SNAPSHOT_VERSION;
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
  failedItems: number;
  failedComments: number;
  warnings: string[];
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
  failedItems: number;
  failedComments: number;
  warnings: string[];
};

const SYNC_PROGRESS_KEY = "sync.progress";

/**
 * Sync runtime tunables loaded from the settings catalog at the start of
 * a run and threaded through the pipeline. Pulling them once per run
 * (instead of on every chunk) keeps the hot path off the settings table
 * and makes a run's behavior consistent even if an operator edits a
 * value mid-run. Defaults live in `src/server/settings/catalog.ts`.
 */
type SyncTunables = {
  /** Items per chunk drained from the provider stream. */
  chunkSize: number;
  /**
   * Cap on concurrent chunk-persist tasks. With this > 1, fetching the
   * next page from the provider overlaps with persisting the previous
   * chunk. Bounded so we don't open unbounded parallel write transactions
   * on disjoint chunks.
   */
  maxInflightChunks: number;
  /**
   * Max concurrency for per-row writes inside one chunk (item updates,
   * inbound-change injection, comment reconciliation). The previous
   * unbounded `Promise.all` could open >1k parallel write transactions
   * on first sync of a large repo.
   */
  maxIntraChunkConcurrency: number;
  /** Lease takeover threshold for stuck syncs, in milliseconds. */
  staleProgressMs: number;
  /** Cap on warnings stored in the progress snapshot (older drop first). */
  maxSnapshotWarnings: number;
};

async function loadSyncTunables(db: Db): Promise<SyncTunables> {
  const [
    chunkSize,
    maxInflightChunks,
    maxIntraChunkConcurrency,
    staleMinutes,
    maxSnapshotWarnings,
  ] = await Promise.all([
    loadGlobalSetting(db, "sync.chunk-size"),
    loadGlobalSetting(db, "sync.max-inflight-chunks"),
    loadGlobalSetting(db, "sync.max-intra-chunk-concurrency"),
    loadGlobalSetting(db, "sync.stale-progress-minutes"),
    loadGlobalSetting(db, "sync.max-snapshot-warnings"),
  ]);
  return {
    chunkSize,
    maxInflightChunks,
    maxIntraChunkConcurrency,
    staleProgressMs: staleMinutes * 60_000,
    maxSnapshotWarnings,
  };
}

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
  // Default-missing → 1: rows written before the field existed parse as v1.
  version: z.literal(CURRENT_SNAPSHOT_VERSION).catch(CURRENT_SNAPSHOT_VERSION),
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
  failedItems: nonNegInt.catch(0),
  failedComments: nonNegInt.catch(0),
  warnings: z.array(z.string()).catch([]),
  watermark: z.union([z.null(), isoDate]),
  error: z.string().nullable().catch(null),
});

function encodeProgress(snapshot: SyncProgressSnapshot): string {
  const persisted: PersistedSyncProgressSnapshot = {
    version: CURRENT_SNAPSHOT_VERSION,
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
    failedItems: snapshot.failedItems,
    failedComments: snapshot.failedComments,
    warnings: snapshot.warnings,
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
  if (!result.success) return null;
  // Strip `version` from the in-memory snapshot — it's a wire-format concern.
  const { version: _ignored, ...rest } = result.data;
  return rest;
}

/**
 * Thrown when a different sync run already holds the lease for this
 * project. Caught by `runSync` so the losing instance exits cleanly.
 *
 * The lease is the `sync.progress` row itself: only one runId can be
 * "running" at a time within `tunables.staleProgressMs`. The atomic
 * upsert below either takes the lease or returns no row, and that
 * empty result is what raises this error.
 */
class SyncLeaseConflictError extends Error {
  constructor(projectId: ProjectId, runId: string) {
    super(`sync lease for project ${projectId} held by another run (this run=${runId})`);
    this.name = "SyncLeaseConflictError";
  }
}

/**
 * Atomic upsert of the sync progress row, doubling as the cross-process
 * lease. Single SQL statement: INSERT … ON CONFLICT … DO UPDATE … WHERE …
 * RETURNING. Returns `true` if this run still holds the lease (insert ran
 * or update applied), `false` if the conflicting row belongs to a fresher
 * run and the update was filtered out by `setWhere`.
 *
 * The `setWhere` admits an update only when:
 *   - it's our own runId (heartbeat / phase transition / final write), OR
 *   - the existing run already finished (`done` / `failed`), OR
 *   - the existing run hasn't heartbeat in `tunables.staleProgressMs` (crash
 *     recovery — assume the previous instance is dead).
 *
 * The previous implementation did `findFirst` → branch insert/update with
 * a 23505 catch; that left a small race window between the read and the
 * write. The single-statement form closes the window and works for two
 * Node processes hitting the same project simultaneously.
 */
async function upsertProgress(
  db: Db,
  projectId: ProjectId,
  snapshot: SyncProgressSnapshot,
  staleProgressMs: number,
): Promise<boolean> {
  const encoded = encodeProgress(snapshot);
  const staleBefore = new Date(Date.now() - staleProgressMs).toISOString();
  const rows = await db
    .insert(settings)
    .values({
      key: SYNC_PROGRESS_KEY,
      scope: "project",
      projectId,
      value: encoded,
    })
    .onConflictDoUpdate({
      target: [settings.key, settings.projectId],
      targetWhere: sql`${settings.userId} IS NULL AND ${settings.projectId} IS NOT NULL`,
      set: {
        value: encoded,
        updatedAt: new Date(),
      },
      setWhere: sql`
        (${settings.value})::jsonb ->> 'runId' = ${snapshot.runId}
        OR (${settings.value})::jsonb ->> 'status' IN ('done', 'failed')
        OR (${settings.value})::jsonb ->> 'updatedAt' < ${staleBefore}
      `,
    })
    .returning({ id: settings.id });
  return rows.length > 0;
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

  const staleMinutes = await loadGlobalSetting(db, "sync.stale-progress-minutes");
  const staleProgressMs = staleMinutes * 60_000;
  if (
    snapshot.status === "running" &&
    Date.now() - snapshot.updatedAt.getTime() > staleProgressMs
  ) {
    const failed: SyncProgressSnapshot = {
      ...snapshot,
      status: "failed",
      finishedAt: snapshot.finishedAt ?? new Date(),
      updatedAt: new Date(),
      error: snapshot.error ?? "Sync appears stale (no progress heartbeat).",
    };
    // Best-effort: if a fresher run beat us to the row, the upsert no-ops.
    await upsertProgress(db, projectId, failed, staleProgressMs);
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
  linkedItemIds: ProviderItemId[];
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
    providerItemId: canonical.id,
    kind: canonical.kind,
    title: canonical.title,
    description: canonical.description,
    state: canonical.state,
    assignees: [...assignees],
    reviewers: [...(canonical.reviewers ?? [])],
    linkedItemIds: [...(canonical.linkedItemIds ?? [])],
    author: canonical.author ?? null,
    parentId: canonical.parentId,
    tags: [...canonical.tags],
    providerRaw: { ...canonical.providerRaw },
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
  failedItems: number;
  failedComments: number;
  warnings: string[];
};

type UpsertProgressSnapshot = {
  upserted: number;
  inboundConversations: number;
  commentsReconciled: number;
  failedItems: number;
  failedComments: number;
  warnings: string[];
  chunks: number;
  itemsSeen: number;
  latestUpdatedAt: Date | null;
};

/**
 * Run `task` over each item with at most `concurrency` in-flight, in input
 * order. Result array is the same length as `items`; each slot is the
 * resolved value from the corresponding task. Errors propagate (use the
 * `Settled` variant when partial failure is expected).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await task(items[i] as T, i);
      }
    }),
  );
  return results;
}

/**
 * Same as `mapWithConcurrency` but each task is wrapped so failures don't
 * abort siblings — returns a `PromiseSettledResult`-shaped tuple per slot.
 * Used for per-row writes inside one chunk where one bad row should not
 * tank the rest of the batch.
 */
async function mapWithConcurrencySettled<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapWithConcurrency(items, concurrency, async (value, index) => {
    try {
      return { status: "fulfilled" as const, value: await task(value, index) };
    } catch (reason) {
      return { status: "rejected" as const, reason };
    }
  });
}

/**
 * Persist a chunk of bundled changes (item + optional comments): bulk-load
 * existing item rows, split into create/update sets, then write each set
 * with bounded fan-out via `mapWithConcurrencySettled`. Per-row failures
 * are counted and surfaced through `ChunkResult` rather than aborting the
 * whole chunk; the next sync cycle will retry failed rows because their
 * cached `updatedAt` won't have advanced.
 */
async function processChunk(
  db: Db,
  projectId: ProjectId,
  bundles: readonly ChangedItem[],
  syncedAt: Date,
  ctx: { syncId: string; chunkIndex: number; providerKind: string },
  tunables: SyncTunables,
): Promise<ChunkResult> {
  const startedAt = Date.now();
  const ids = bundles.map((b) => b.item.id);
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
    const providerItemId = item.id;
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
  let failedItems = 0;
  const warnings: string[] = [];

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
    // Bounded fan-out + per-row settled results: one failed update no
    // longer aborts the chunk. Failed rows surface through `failedItems`
    // and the next cycle re-syncs them.
    const settled = await mapWithConcurrencySettled(
      toUpdate,
      tunables.maxIntraChunkConcurrency,
      ({ providerItemId, row }) =>
        db
          .update(items)
          .set({ ...row, archived: false })
          .where(and(eq(items.projectId, projectId), eq(items.providerItemId, providerItemId))),
    );
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (!r) continue;
      if (r.status === "fulfilled") {
        upserted++;
      } else {
        failedItems++;
        const offender = toUpdate[i];
        if (offender) {
          warnings.push(`item ${offender.providerItemId}: update failed`);
          logger.warn(
            {
              syncId: ctx.syncId,
              projectId,
              chunkIndex: ctx.chunkIndex,
              providerItemId: offender.providerItemId,
              err: r.reason instanceof Error ? r.reason.message : String(r.reason),
            },
            "sync: item update failed (continuing)",
          );
        }
      }
    }
  }

  let inboundConversations = 0;
  if (changedExisting.length > 0) {
    const settled = await mapWithConcurrencySettled(
      changedExisting,
      tunables.maxIntraChunkConcurrency,
      (c) =>
        injectExternalChange(db, {
          projectId,
          itemId: c.itemId,
          providerItemId: c.providerItemId,
          changes: c.changes,
        }),
    );
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (!r) continue;
      if (r.status === "fulfilled") {
        inboundConversations += r.value.injectedInto;
      } else {
        const offender = changedExisting[i];
        if (offender) {
          warnings.push(`item ${offender.providerItemId}: inbound-change inject failed`);
          logger.warn(
            {
              syncId: ctx.syncId,
              projectId,
              chunkIndex: ctx.chunkIndex,
              providerItemId: offender.providerItemId,
              err: r.reason instanceof Error ? r.reason.message : String(r.reason),
            },
            "sync: inbound-change injection failed (continuing)",
          );
        }
      }
    }
  }

  let commentsReconciled = 0;
  let failedComments = 0;
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
    const reconcileResult = await reconcileComments(
      db,
      reconcileBundles,
      tunables.maxIntraChunkConcurrency,
    );
    commentsReconciled += reconcileResult.touched;
    failedComments += reconcileResult.failed;
    if (reconcileResult.warnings.length > 0) warnings.push(...reconcileResult.warnings);
  }

  // Warm the avatar cache for assignees in this chunk so the first item-
  // list render after sync has bytes ready instead of flickering through
  // the lazy-fetch path. Best-effort + fire-and-forget — sync should never
  // fail because an avatar fetch did, and the loop itself bounds
  // concurrency internally. Failures are recorded as a snapshot warning so
  // the operator can tell when the asset cache is stale.
  const assigneeLogins = collectAssignees(bundles);
  if (assigneeLogins.length > 0) {
    void warmAvatars(db, {
      providerKind: ctx.providerKind,
      identifiers: assigneeLogins,
    }).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(`avatar warm: ${reason}`);
      logger.warn(
        {
          syncId: ctx.syncId,
          projectId,
          chunkIndex: ctx.chunkIndex,
          err: reason,
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
      failedItems,
      failedComments,
      chunkMs: Date.now() - startedAt,
    },
    "sync: chunk persisted",
  );

  return {
    upserted,
    inboundConversations,
    commentsReconciled,
    failedItems,
    failedComments,
    warnings,
  };
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
 * per-comment writes fan out under the caller-supplied `concurrency` (the
 * sync pipeline threads `tunables.maxIntraChunkConcurrency` here; the
 * executor passes a small default since it reconciles one bundle at a
 * time). Skip-rewrite: comments whose `providerUpdatedAt` matches the
 * cached row (and whose body matches) are left untouched. Returns counts
 * of writes that touched the DB and writes that failed (with per-failure
 * warnings).
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

export type ReconcileCommentsResult = {
  touched: number;
  failed: number;
  warnings: string[];
};

type CommentInsertRow = typeof comments.$inferInsert;
type CommentUpdate = {
  itemSurrogate: ItemId;
  providerCommentId: string;
  fields: {
    author: string;
    body: string;
    createdAt: Date;
    providerUpdatedAt: Date | null;
    edited: boolean;
    reactions: CanonicalComment["reactions"] | null;
  };
};

export async function reconcileComments(
  db: Db | DbTx,
  bundles: readonly CommentReconcileBundle[],
  concurrency = 8,
): Promise<ReconcileCommentsResult> {
  const nonEmpty = bundles.filter((b) => b.comments.length > 0);
  if (nonEmpty.length === 0) return { touched: 0, failed: 0, warnings: [] };
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
  const inserts: CommentInsertRow[] = [];
  const updates: CommentUpdate[] = [];
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
        updates.push({
          itemSurrogate,
          providerCommentId: c.id,
          fields: {
            author: c.author,
            body: c.body,
            createdAt: c.createdAt,
            providerUpdatedAt: incomingPu,
            edited: c.edited ?? false,
            reactions,
          },
        });
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
      }
    }
  }
  if (inserts.length === 0 && updates.length === 0) {
    return { touched: 0, failed: 0, warnings: [] };
  }

  const warnings: string[] = [];
  let touched = 0;
  let failed = 0;

  if (inserts.length > 0) {
    try {
      await db
        .insert(comments)
        .values(inserts)
        .onConflictDoNothing({ target: [comments.itemId, comments.providerCommentId] });
      touched += inserts.length;
    } catch (err) {
      // Batched insert failed atomically — we don't know which row was the
      // offender. Re-run one row at a time so the rest still land.
      const settled = await mapWithConcurrencySettled(inserts, concurrency, (row) =>
        db
          .insert(comments)
          .values(row)
          .onConflictDoNothing({ target: [comments.itemId, comments.providerCommentId] }),
      );
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (!r) continue;
        if (r.status === "fulfilled") {
          touched++;
        } else {
          failed++;
          const offender = inserts[i];
          warnings.push(`comment insert ${offender?.providerCommentId ?? "?"}: failed`);
        }
      }
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), batchSize: inserts.length },
        "sync: batched comment insert failed; fell back to per-row",
      );
    }
  }

  if (updates.length > 0) {
    const settled = await mapWithConcurrencySettled(updates, concurrency, (u) =>
      db
        .update(comments)
        .set(u.fields)
        .where(
          and(
            eq(comments.itemId, u.itemSurrogate),
            eq(comments.providerCommentId, u.providerCommentId),
          ),
        ),
    );
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (!r) continue;
      if (r.status === "fulfilled") {
        touched++;
      } else {
        failed++;
        const offender = updates[i];
        warnings.push(`comment update ${offender?.providerCommentId ?? "?"}: failed`);
      }
    }
  }

  return { touched, failed, warnings };
}

async function upsertItems(
  db: Db,
  projectId: ProjectId,
  providerKind: string,
  bundles: AsyncIterable<ChangedItem>,
  syncedAt: Date,
  syncId: string,
  tunables: SyncTunables,
  onProgress?: (snapshot: UpsertProgressSnapshot) => Promise<void> | void,
): Promise<{
  upserted: number;
  seenIds: Set<string>;
  latestUpdatedAt: Date | null;
  inboundConversations: number;
  commentsReconciled: number;
  failedItems: number;
  failedComments: number;
  warnings: string[];
  chunks: number;
  itemsSeen: number;
}> {
  let upserted = 0;
  let latestUpdatedAt: Date | null = null;
  let inboundConversations = 0;
  let commentsReconciled = 0;
  let failedItems = 0;
  let failedComments = 0;
  const warnings: string[] = [];
  let chunks = 0;
  const seenIds = new Set<string>();
  let buffer: ChangedItem[] = [];
  const inflight = new Set<Promise<void>>();
  let firstItemAt: number | null = null;
  const streamStartedAt = Date.now();

  const fire = (chunk: readonly ChangedItem[]) => {
    const chunkIndex = chunks++;
    const task = processChunk(
      db,
      projectId,
      chunk,
      syncedAt,
      {
        syncId,
        chunkIndex,
        providerKind,
      },
      tunables,
    ).then(async (r) => {
      upserted += r.upserted;
      inboundConversations += r.inboundConversations;
      commentsReconciled += r.commentsReconciled;
      failedItems += r.failedItems;
      failedComments += r.failedComments;
      if (r.warnings.length > 0) warnings.push(...r.warnings);
      if (onProgress) {
        await onProgress({
          upserted,
          inboundConversations,
          commentsReconciled,
          failedItems,
          failedComments,
          warnings,
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
    if (buffer.length >= tunables.chunkSize) {
      const chunk = buffer;
      buffer = [];
      fire(chunk);
      // Bound the number of in-flight chunks so we hide one DB round-trip
      // behind the next provider-page fetch without spawning unbounded
      // parallel write transactions.
      while (inflight.size >= tunables.maxInflightChunks) {
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
    failedItems,
    failedComments,
    warnings,
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

function trimWarnings(list: string[], cap: number): string[] {
  if (list.length <= cap) return list;
  return list.slice(list.length - cap);
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
  const projectId = project.id;
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
    failedItems: 0,
    failedComments: 0,
    warnings: [],
    watermark: null,
    error: null,
  };

  const tunables = await loadSyncTunables(db);

  // Returns whether this run still owns the lease. On the very first call,
  // a `false` means another run already holds it — we abort cleanly.
  const persistProgress = async (): Promise<boolean> => {
    progress = {
      ...progress,
      updatedAt: new Date(),
      warnings: trimWarnings(progress.warnings, tunables.maxSnapshotWarnings),
    };
    return upsertProgress(db, projectId, progress, tunables.staleProgressMs);
  };

  try {
    const acquired = await persistProgress();
    if (!acquired) {
      throw new SyncLeaseConflictError(projectId, syncId);
    }

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
      failedItems,
      failedComments,
      warnings: streamWarnings,
      chunks,
      itemsSeen,
    } = await upsertItems(
      db,
      projectId,
      project.providerKind,
      provider.listChangesSince(watermark),
      syncedAt,
      syncId,
      tunables,
      async (chunkProgress) => {
        progress = {
          ...progress,
          phase: "persist",
          chunksCompleted: chunkProgress.chunks,
          itemsSeen: chunkProgress.itemsSeen,
          upserted: chunkProgress.upserted,
          inboundConversations: chunkProgress.inboundConversations,
          commentsReconciled: chunkProgress.commentsReconciled,
          failedItems: chunkProgress.failedItems,
          failedComments: chunkProgress.failedComments,
          warnings: chunkProgress.warnings,
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
        failedItems,
        failedComments,
        warnings: streamWarnings,
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
      failedItems,
      failedComments,
      warnings: streamWarnings,
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
        failedItems,
        failedComments,
        warnings: streamWarnings.length,
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
      failedItems,
      failedComments,
      warnings: streamWarnings,
    };
  } catch (err) {
    if (err instanceof SyncLeaseConflictError) {
      logger.info({ ...baseCtx }, "sync: skipped (another run holds the lease)");
      return {
        upserted: 0,
        archived: 0,
        watermark: null,
        inboundConversations: 0,
        failedItems: 0,
        failedComments: 0,
        warnings: [],
      };
    }
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
