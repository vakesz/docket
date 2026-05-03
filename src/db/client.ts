import "server-only";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { logger } from "@/server/logger";

// Per-connection guard rails. A runaway query can lock workers; an idle
// transaction can pin the row it touched until a reaper notices. These caps
// are well above what any healthy code path needs (sync chunks finish in
// hundreds of ms; the longest tx is the proposal executor's confirm path)
// and trip loudly when something pathological is in flight. Tunable via env
// for deployments with bigger workloads.
const STATEMENT_TIMEOUT_MS = Number(process.env["DB_STATEMENT_TIMEOUT_MS"] ?? 30_000);
const IDLE_IN_TX_TIMEOUT_MS = Number(process.env["DB_IDLE_IN_TX_TIMEOUT_MS"] ?? 60_000);
const POOL_MAX = Number(process.env["DB_POOL_MAX"] ?? 10);

function makeClient() {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  }
  // postgres-js pools per-process. To cap connections behind PgBouncer or
  // multiple Node workers, set DB_POOL_MAX. statement_timeout and
  // idle_in_transaction_session_timeout are passed as connection-level GUC
  // overrides — postgres-js sets them on each connection during the startup
  // packet so every query inherits the cap.
  const sql = postgres(connectionString, {
    max: POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: true,
    connection: {
      application_name: "docket",
      statement_timeout: STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: IDLE_IN_TX_TIMEOUT_MS,
    },
  });
  const isDev = process.env.NODE_ENV === "development";
  return drizzle(sql, {
    schema,
    casing: "snake_case",
    logger: isDev
      ? {
          logQuery: (query, params) => {
            logger.debug({ query, params }, "drizzle query");
          },
        }
      : false,
  });
}

export type Db = PostgresJsDatabase<typeof schema>;
// Inside a transaction callback Drizzle hands us a transactional client with
// the same query surface as the top-level `db`. Helpers that participate in a
// caller-owned transaction take `tx: DbTx` rather than `db: Db`.
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Stash on globalThis so Next.js HMR re-imports don't leak duplicate clients
// — `globalThis` survives module re-evaluation, the module-scoped variable
// does not. Declared via `declare global` so the access is fully typed
// without an `as unknown as` escape.
declare global {
  var __docketDb: Db | undefined;
}

function getClient(): Db {
  globalThis.__docketDb ??= makeClient();
  return globalThis.__docketDb;
}

/**
 * Lazy Drizzle client proxy. The actual client is constructed on first
 * property access so importing this module never fails at build time when
 * env vars aren't populated yet (e.g. during `next build`).
 *
 * The proxy target is the typed `Db` so `db.query.projects.findFirst(...)`
 * and `db.insert(projects).values(...)` keep their full inference. Branded
 * id columns (`ProjectId`, `UserId`, etc.) flow natively through every
 * read and write — there is no extension layer.
 *
 * The `getPrototypeOf` trap is load-bearing for `@auth/drizzle-adapter`,
 * which detects the dialect via drizzle's `is(db, PgDatabase)` — that
 * helper walks `Object.getPrototypeOf(value)` looking for the
 * `entityKind` symbol. Without the trap, the chain stops at the empty
 * proxy target's `Object.prototype` and the adapter throws
 * "Unsupported database type (object)".
 */
export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient(), prop, receiver);
  },
  getPrototypeOf() {
    return Reflect.getPrototypeOf(getClient());
  },
});
