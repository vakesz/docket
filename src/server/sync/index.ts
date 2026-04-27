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
 */

import "server-only";
import type { Item as CanonicalItem } from "@/core/types";
import type { Prisma } from "@/db/generated/client";
import type { db as Db } from "@/server/db";
import { injectExternalChange, materialDiff } from "@/server/inbound-changes/inject";
import { buildProviderForUser } from "@/server/providers/build";

type ProjectArg = Parameters<typeof buildProviderForUser>[1];

export type SyncResult = {
  upserted: number;
  archived: number;
  watermark: Date | null;
  /** Number of (active) conversations that received an inbound-change notice. */
  inboundConversations: number;
};

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
  for await (const item of items) {
    const cached = await db.item.findUnique({
      where: {
        projectId_providerItemId: { projectId, providerItemId: item.id },
      },
      select: { id: true, state: true, title: true, descriptionMd: true, assignee: true },
    });

    const row = toItemRow(item, projectId, syncedAt);
    const upserted_row = await db.item.upsert({
      where: {
        projectId_providerItemId: { projectId, providerItemId: item.id },
      },
      create: row,
      update: { ...row, archived: false },
      select: { id: true },
    });

    if (cached) {
      const changes = materialDiff(cached, item);
      if (changes.length > 0) {
        const result = await injectExternalChange(db, {
          projectId,
          itemId: upserted_row.id,
          providerItemId: item.id,
          changes,
        });
        inboundConversations += result.injectedInto;
      }
    }

    upserted += 1;
    seenIds.add(item.id);
    if (item.updatedAt && (!latestUpdatedAt || item.updatedAt > latestUpdatedAt)) {
      latestUpdatedAt = item.updatedAt;
    }
  }
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
