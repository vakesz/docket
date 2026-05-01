import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/db/generated/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Per-connection guard rails. A runaway query can lock workers; an idle
// transaction can pin the row it touched until a reaper notices. These caps
// are well above what any healthy code path needs (sync chunks finish in
// hundreds of ms; the longest tx is the proposal executor's confirm path)
// and trip loudly when something pathological is in flight. Tunable via env
// for deployments with bigger workloads.
const STATEMENT_TIMEOUT_MS = Number(process.env["DB_STATEMENT_TIMEOUT_MS"] ?? 30_000);
const IDLE_IN_TX_TIMEOUT_MS = Number(process.env["DB_IDLE_IN_TX_TIMEOUT_MS"] ?? 60_000);

function makeClient(): PrismaClient {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  }
  // Pool sizing is delegated to node-postgres via the adapter. To cap
  // per-process connections (e.g. behind PgBouncer or with multiple Node
  // workers), append `?connection_limit=N` to DATABASE_URL — the driver
  // honors it. See `.env.example` for the deployment-side note.
  const adapter = new PrismaPg({
    connectionString,
    application_name: "docket",
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TX_TIMEOUT_MS,
  });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["error"],
  });
}

function getClient(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = makeClient();
  }
  return globalForPrisma.prisma;
}

/**
 * Lazy Prisma client proxy. The actual client is constructed on first property
 * access so importing this module never fails at build time when env vars
 * aren't populated yet (e.g. during `next build`).
 */
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    return Reflect.get(getClient(), prop);
  },
});
