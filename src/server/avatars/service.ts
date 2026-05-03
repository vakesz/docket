// 30-day TTL — avatars rarely change. A failed fetch stamps `failedAt`
// and backs off for an hour to avoid hammering a briefly-down provider.

import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { avatars } from "@/db/schema";
import { fetchAvatarFromProvider } from "@/server/avatars/fetchers";
import { logger } from "@/server/logger";

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 60 * 60 * 1000;

export type AvatarRow = {
  bytes: Uint8Array | null;
  contentType: string | null;
  etag: string | null;
  fetchedAt: Date;
  failedAt: Date | null;
};

export type ServeResult =
  | {
      kind: "ok";
      bytes: Uint8Array;
      contentType: string;
      etag: string | null;
      fetchedAt: Date;
    }
  | { kind: "missing" };

/**
 * Serve a cached avatar, lazily populating on miss. Returns a `missing`
 * sentinel rather than throwing so the route handler can map directly to a
 * 404. Stale rows are served immediately; the refresh runs in the
 * background so the requesting render isn't blocked by a network round
 * trip.
 */
export async function serveAvatar(
  db: Db,
  opts: {
    providerKind: string;
    identifier: string;
  },
): Promise<ServeResult> {
  const row = await db.query.avatars.findFirst({
    where: and(
      eq(avatars.providerKind, opts.providerKind),
      eq(avatars.identifier, opts.identifier),
    ),
    columns: {
      bytes: true,
      contentType: true,
      etag: true,
      fetchedAt: true,
      failedAt: true,
    },
  });

  if (row) {
    if (row.bytes && row.contentType) {
      maybeRefreshInBackground(db, opts, row);
      return {
        kind: "ok",
        bytes: ensureUint8Array(row.bytes),
        contentType: row.contentType,
        etag: row.etag,
        fetchedAt: row.fetchedAt,
      };
    }
    if (row.failedAt && Date.now() - row.failedAt.getTime() < FAILURE_BACKOFF_MS) {
      return { kind: "missing" };
    }
    if (row.bytes === null && row.failedAt === null) {
      // Confirmed-missing (the provider 404'd at last fetch). Treat as
      // permanent until refresh TTL expires.
      if (Date.now() - row.fetchedAt.getTime() < REFRESH_TTL_MS) {
        return { kind: "missing" };
      }
    }
  }

  const fetched = await tryFetch(opts);
  await persistResult(db, opts, fetched);
  if (fetched?.bytes && fetched.contentType) {
    return {
      kind: "ok",
      bytes: fetched.bytes,
      contentType: fetched.contentType,
      etag: fetched.etag ?? null,
      fetchedAt: new Date(),
    };
  }
  return { kind: "missing" };
}

/**
 * Stamp pre-fetched bytes onto the cache. Used by the auth profile
 * callbacks where we already have the bytes in hand and don't need to
 * round-trip through the lazy path.
 */
export async function persistAvatar(
  db: Db,
  opts: {
    providerKind: string;
    identifier: string;
    bytes: Uint8Array | null;
    contentType?: string | null;
    etag?: string | null;
  },
): Promise<void> {
  const bytes = opts.bytes ?? null;
  const contentType = opts.contentType ?? null;
  const etag = opts.etag ?? null;
  await db
    .insert(avatars)
    .values({
      providerKind: opts.providerKind,
      identifier: opts.identifier,
      bytes,
      contentType,
      etag,
      failedAt: null,
    })
    .onConflictDoUpdate({
      target: [avatars.providerKind, avatars.identifier],
      set: {
        bytes,
        contentType,
        etag,
        fetchedAt: new Date(),
        failedAt: null,
      },
    });
}

const WARM_CONCURRENCY = 4;

export async function warmAvatars(
  db: Db,
  opts: {
    providerKind: string;
    identifiers: readonly string[];
    accessToken?: string | null;
    selfIdentifier?: string | null;
  },
): Promise<void> {
  const unique = Array.from(new Set(opts.identifiers.filter((s) => s.length > 0)));
  if (unique.length === 0) return;

  const existing = await db.query.avatars.findMany({
    where: and(eq(avatars.providerKind, opts.providerKind), inArray(avatars.identifier, unique)),
    columns: { identifier: true, fetchedAt: true, bytes: true, failedAt: true },
  });
  const skipSet = new Set<string>();
  const now = Date.now();
  for (const row of existing) {
    const stale = now - row.fetchedAt.getTime() > REFRESH_TTL_MS;
    if (stale) continue;
    if (row.failedAt && now - row.failedAt.getTime() < FAILURE_BACKOFF_MS) {
      skipSet.add(row.identifier);
      continue;
    }
    if (row.bytes !== null || row.failedAt === null) {
      skipSet.add(row.identifier);
    }
  }

  const todo = unique.filter((id) => !skipSet.has(id));
  if (todo.length === 0) return;

  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(WARM_CONCURRENCY, todo.length); i++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= todo.length) return;
          const identifier = todo[idx];
          if (identifier === undefined) return;
          const single = {
            providerKind: opts.providerKind,
            identifier,
            ...(opts.accessToken !== undefined ? { accessToken: opts.accessToken } : {}),
            isSelf: opts.selfIdentifier !== null && identifier === opts.selfIdentifier,
          };
          const fetched = await tryFetch(single);
          await persistResult(db, single, fetched);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

async function tryFetch(opts: {
  providerKind: string;
  identifier: string;
  accessToken?: string | null;
  isSelf?: boolean;
}): Promise<{ bytes: Uint8Array | null; contentType: string | null; etag: string | null } | null> {
  try {
    const result = await fetchAvatarFromProvider(opts.providerKind, opts.identifier, {
      ...(opts.accessToken !== undefined ? { accessToken: opts.accessToken } : {}),
      ...(opts.isSelf !== undefined ? { isSelf: opts.isSelf } : {}),
    });
    if (result === null) {
      return { bytes: null, contentType: null, etag: null };
    }
    return { bytes: result.bytes, contentType: result.contentType, etag: result.etag ?? null };
  } catch (err) {
    logger.warn(
      {
        providerKind: opts.providerKind,
        identifier: opts.identifier,
        err: err instanceof Error ? err.message : String(err),
      },
      "avatars: provider fetch threw; recording transient failure",
    );
    return null;
  }
}

async function persistResult(
  db: Db,
  opts: { providerKind: string; identifier: string },
  fetched: { bytes: Uint8Array | null; contentType: string | null; etag: string | null } | null,
): Promise<void> {
  const now = new Date();
  if (fetched === null) {
    await db
      .insert(avatars)
      .values({
        providerKind: opts.providerKind,
        identifier: opts.identifier,
        bytes: null,
        failedAt: now,
      })
      .onConflictDoUpdate({
        target: [avatars.providerKind, avatars.identifier],
        set: { failedAt: now, fetchedAt: now },
      });
    return;
  }
  await db
    .insert(avatars)
    .values({
      providerKind: opts.providerKind,
      identifier: opts.identifier,
      bytes: fetched.bytes,
      contentType: fetched.contentType,
      etag: fetched.etag,
      failedAt: null,
    })
    .onConflictDoUpdate({
      target: [avatars.providerKind, avatars.identifier],
      set: {
        bytes: fetched.bytes,
        contentType: fetched.contentType,
        etag: fetched.etag,
        fetchedAt: now,
        failedAt: null,
      },
    });
}

function maybeRefreshInBackground(
  db: Db,
  opts: {
    providerKind: string;
    identifier: string;
    accessToken?: string | null;
    isSelf?: boolean;
  },
  row: { fetchedAt: Date; failedAt: Date | null },
): void {
  if (row.failedAt && Date.now() - row.failedAt.getTime() < FAILURE_BACKOFF_MS) return;
  if (Date.now() - row.fetchedAt.getTime() < REFRESH_TTL_MS) return;
  void (async () => {
    try {
      const fetched = await tryFetch(opts);
      await persistResult(db, opts, fetched);
    } catch (err) {
      logger.warn(
        {
          providerKind: opts.providerKind,
          identifier: opts.identifier,
          err: err instanceof Error ? err.message : String(err),
        },
        "avatars: background refresh failed",
      );
    }
  })();
}

function ensureUint8Array(value: Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : Uint8Array.from(value as ArrayLike<number>);
}
