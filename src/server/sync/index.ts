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
import type { Item as CanonicalItem } from "@/core/types";
import type { Prisma } from "@/db/generated/client";
import type { db as Db } from "@/server/db";
import {
  injectExternalChange,
  type MaterialChange,
  materialDiff,
} from "@/server/inbound-changes/inject";
import { buildProviderForUser } from "@/server/providers/build";

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
  return {
    projectId,
    providerItemId: canonical.id,
    kind: canonical.kind,
    title: canonical.title,
    descriptionMd: canonical.descriptionMd,
    state: canonical.state,
    assignee: canonical.assignee,
    author: canonical.author,
    parentId: canonical.parentId,
    tags: canonical.tags,
    providerRaw: canonical.providerRaw as Prisma.InputJsonValue,
    url: canonical.url,
    repositoryUrl: canonical.repositoryUrl,
    createdAt: canonical.createdAt,
    updatedAt: canonical.updatedAt ?? syncedAt,
    syncedAt,
    archived: false,
  };
}

type ChunkResult = {
  upserted: number;
  inboundConversations: number;
};

/**
 * Persist a chunk of canonical items: bulk-load existing rows, split into
 * create/update sets, then write each set in one DB call. Material diffs
 * for already-cached items fan out into `injectExternalChange` in
 * parallel — new items have no prior conversation context so they skip
 * the inject step entirely.
 */
async function processChunk(
  db: typeof Db,
  projectId: string,
  chunk: readonly CanonicalItem[],
  syncedAt: Date,
): Promise<ChunkResult> {
  const ids = chunk.map((i) => i.id);
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

  for (const item of chunk) {
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

  return { upserted, inboundConversations };
}

async function upsertItems(
  db: typeof Db,
  projectId: string,
  items: AsyncIterable<CanonicalItem>,
  syncedAt: Date,
): Promise<{
  upserted: number;
  seenIds: Set<string>;
  latestUpdatedAt: Date | null;
  inboundConversations: number;
}> {
  let upserted = 0;
  let latestUpdatedAt: Date | null = null;
  let inboundConversations = 0;
  const seenIds = new Set<string>();
  let buffer: CanonicalItem[] = [];
  const inflight = new Set<Promise<void>>();

  const fire = (chunk: readonly CanonicalItem[]) => {
    const task = processChunk(db, projectId, chunk, syncedAt).then((r) => {
      upserted += r.upserted;
      inboundConversations += r.inboundConversations;
    });
    const tracked = task.finally(() => {
      inflight.delete(tracked);
    });
    inflight.add(tracked);
    return tracked;
  };

  for await (const item of items) {
    buffer.push(item);
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

  return { upserted, seenIds, latestUpdatedAt, inboundConversations };
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
  const provider = await buildProviderForUser(db, project, userId);
  const cursor = await db.syncCursor.findUnique({ where: { projectId: project.id } });
  const watermark = cursor?.watermark ?? null;
  const syncedAt = new Date();

  const { upserted, latestUpdatedAt, inboundConversations } = await upsertItems(
    db,
    project.id,
    provider.listChangesSince(watermark),
    syncedAt,
  );

  const newWatermark = latestUpdatedAt ?? watermark;
  await bumpCursor(db, project.id, newWatermark, null);
  return { upserted, archived: 0, watermark: newWatermark, inboundConversations };
}

export async function runFullSync(
  db: typeof Db,
  project: ProjectArg,
  userId: string,
): Promise<SyncResult> {
  const provider = await buildProviderForUser(db, project, userId);
  const syncedAt = new Date();

  const { upserted, seenIds, latestUpdatedAt, inboundConversations } = await upsertItems(
    db,
    project.id,
    provider.listChangesSince(null),
    syncedAt,
  );

  // Archive any cached row not seen in the full walk. Excluding already-
  // archived rows keeps the update count meaningful.
  const archive = await db.item.updateMany({
    where: {
      projectId: project.id,
      providerItemId: { notIn: Array.from(seenIds) },
      archived: false,
    },
    data: { archived: true },
  });

  await bumpCursor(db, project.id, latestUpdatedAt, syncedAt);
  return {
    upserted,
    archived: archive.count,
    watermark: latestUpdatedAt,
    inboundConversations,
  };
}
