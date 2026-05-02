/**
 * Post-`prisma db push` raw-SQL bootstrap. Idempotent.
 *
 * Prisma 7 doesn't model partial unique indexes or GIN/pg_trgm indexes
 * declaratively — anything that lives outside of `schema.prisma` lands
 * here. Wired into `predev` (after `prisma db push`) and into
 * `docker-entrypoint.sh` so dev and self-host stay in lockstep.
 *
 * What it applies:
 *   1. `pg_trgm` extension — required for the GIN trgm indexes below.
 *   2. Three partial unique indexes on `Setting` so per-scope uniqueness is
 *      enforced even though Postgres treats NULL as distinct in plain
 *      uniques. The previous `@@unique([key, userId, projectId])` was a
 *      no-op for the global / partial-NULL scopes.
 *   3. GIN trgm indexes on `Item.title` and `Item.description` to back
 *      the ILIKE-style search (`title contains`, `description contains`)
 *      run by the items router and the agent's `search_items` tool.
 *
 * Missing env or unavailable DB just logs a warning and exits 0 — never
 * blocks the server.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";
import { PrismaClient } from "../src/db/generated/client";

// Match prisma.config.ts precedence: .env.local first, then .env fills any gaps.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

async function main() {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.warn("[apply-raw-sql] DATABASE_URL not set — skipping.");
    return;
  }

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const db = new PrismaClient({ adapter, log: ["error"] });

  try {
    await db.$executeRaw`CREATE EXTENSION IF NOT EXISTS pg_trgm;`;

    // The auto-generated unique from `@@unique([key, userId, projectId])`
    // was named `Setting_key_userId_projectId_key`. Drop it if present so
    // the partial uniques below are the only enforcement on this column
    // tuple. Safe to drop unconditionally — the partials are stricter.
    await db.$executeRaw`DROP INDEX IF EXISTS "Setting_key_userId_projectId_key";`;

    // Pre-flight: any existing duplicates would block partial-unique
    // creation with a generic "could not create unique index" error that
    // gets swallowed by the catch below. Surface them loudly first so the
    // operator (or a developer with a stale dev DB) notices instead of
    // silently running without per-scope uniqueness enforcement.
    const dupes = await db.$queryRaw<
      Array<{ scope: string; key: string; count: bigint; sample_ids: string[] }>
    >`
      SELECT scope, "key", count, sample_ids FROM (
        SELECT 'global' AS scope, "key",
               COUNT(*) AS count,
               (ARRAY_AGG("id"))[1:5] AS sample_ids
        FROM "Setting"
        WHERE "userId" IS NULL AND "projectId" IS NULL
        GROUP BY "key"
        HAVING COUNT(*) > 1
        UNION ALL
        SELECT 'user' AS scope, "key" || ':user=' || "userId",
               COUNT(*) AS count,
               (ARRAY_AGG("id"))[1:5] AS sample_ids
        FROM "Setting"
        WHERE "userId" IS NOT NULL AND "projectId" IS NULL
        GROUP BY "key", "userId"
        HAVING COUNT(*) > 1
        UNION ALL
        SELECT 'project' AS scope, "key" || ':project=' || "projectId",
               COUNT(*) AS count,
               (ARRAY_AGG("id"))[1:5] AS sample_ids
        FROM "Setting"
        WHERE "userId" IS NULL AND "projectId" IS NOT NULL
        GROUP BY "key", "projectId"
        HAVING COUNT(*) > 1
      ) d
      ORDER BY scope, "key"
      LIMIT 50;
    `;
    if (dupes.length > 0) {
      console.warn(
        `[apply-raw-sql] Found ${dupes.length} duplicate Setting groups — partial unique creation will be skipped. De-dup first.`,
      );
      for (const d of dupes.slice(0, 10)) {
        console.warn(
          `[apply-raw-sql]   ${d.scope}: ${d.key} (count=${d.count}, sample ids=${d.sample_ids.join(", ")})`,
        );
      }
    }

    // CONCURRENTLY so building these on a populated DB doesn't take an
    // exclusive write lock on `Setting` / `Item`. CONCURRENTLY can't run
    // inside a transaction, but `$executeRawUnsafe` issues each statement
    // as its own simple-protocol command — no implicit transaction. Idempotent:
    // IF NOT EXISTS skips the build when the index is already present.
    //
    // Global scope: at most one row per key with both FKs null.
    await db.$executeRawUnsafe(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Setting_key_global_key" ON "Setting" ("key") WHERE "userId" IS NULL AND "projectId" IS NULL`,
    );

    // User scope: at most one row per (key, userId) with projectId null.
    await db.$executeRawUnsafe(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Setting_key_userId_key" ON "Setting" ("key", "userId") WHERE "userId" IS NOT NULL AND "projectId" IS NULL`,
    );

    // Project scope: at most one row per (key, projectId) with userId null.
    await db.$executeRawUnsafe(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Setting_key_projectId_key" ON "Setting" ("key", "projectId") WHERE "userId" IS NULL AND "projectId" IS NOT NULL`,
    );

    // GIN trgm indexes for ILIKE search on Item title + description.
    await db.$executeRawUnsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Item_title_trgm_idx" ON "Item" USING GIN ("title" gin_trgm_ops)`,
    );
    await db.$executeRawUnsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Item_description_trgm_idx" ON "Item" USING GIN ("description" gin_trgm_ops)`,
    );

    console.log("[apply-raw-sql] Applied pg_trgm + Setting partial uniques + Item trgm indexes.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[apply-raw-sql] Skipped: ${message}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.warn(`[apply-raw-sql] Unexpected failure (non-fatal): ${err}`);
  process.exit(0);
});
