#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Standalone migration runner. Used in three places:
//   - `pnpm predev` (before `next dev`) for local development.
//   - `bin/docker-entrypoint.sh` on container start.
//   - `pnpm db:migrate` as an operator hook.
//
// Reads `.env.local` then `.env` (mirroring drizzle.config.ts), opens a
// short-lived single-connection pool, runs every pending migration in the
// `drizzle/` folder in order, and exits. drizzle-kit's `__drizzle_migrations`
// ledger tracks what has already been applied so re-runs are no-ops.

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

async function main(): Promise<void> {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    console.error("[migrate] DATABASE_URL is not set; nothing to do.");
    process.exit(0);
  }
  const sql = postgres(connectionString, { max: 1, prepare: false });
  try {
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("[migrate] migrations applied");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
