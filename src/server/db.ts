import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import type {
  ConversationId,
  ItemId,
  MessageId,
  ProjectId,
  ProposalId,
  ProviderItemId,
  UserId,
} from "@/core/types";
import { PrismaClient } from "@/db/generated/client";

// Per-connection guard rails. A runaway query can lock workers; an idle
// transaction can pin the row it touched until a reaper notices. These caps
// are well above what any healthy code path needs (sync chunks finish in
// hundreds of ms; the longest tx is the proposal executor's confirm path)
// and trip loudly when something pathological is in flight. Tunable via env
// for deployments with bigger workloads.
const STATEMENT_TIMEOUT_MS = Number(process.env["DB_STATEMENT_TIMEOUT_MS"] ?? 30_000);
const IDLE_IN_TX_TIMEOUT_MS = Number(process.env["DB_IDLE_IN_TX_TIMEOUT_MS"] ?? 60_000);

function makeClient() {
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
  const base = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["error"],
  });
  // Brand domain id fields on read so the type system carries the proof
  // through the codebase. After this extension, `db.project.findUnique(...)`
  // returns `id: ProjectId` and `ownerUserId: UserId` directly — call sites
  // never need to wrap a string with `asProjectId`/`asUserId`. The remaining
  // legitimate users of `as*` helpers are input parsers (Zod / HTTP), the
  // NextAuth session callback, and env / CLI bootstrap. Everything else
  // flows through types.
  return base.$extends({
    result: {
      user: {
        id: { needs: { id: true }, compute: (u) => u.id as UserId },
        defaultProjectId: {
          needs: { defaultProjectId: true },
          compute: (u) => (u.defaultProjectId === null ? null : (u.defaultProjectId as ProjectId)),
        },
      },
      account: {
        userId: { needs: { userId: true }, compute: (a) => a.userId as UserId },
      },
      session: {
        userId: { needs: { userId: true }, compute: (s) => s.userId as UserId },
      },
      project: {
        id: { needs: { id: true }, compute: (p) => p.id as ProjectId },
        ownerUserId: { needs: { ownerUserId: true }, compute: (p) => p.ownerUserId as UserId },
      },
      projectMembership: {
        projectId: {
          needs: { projectId: true },
          compute: (m) => m.projectId as ProjectId,
        },
        userId: { needs: { userId: true }, compute: (m) => m.userId as UserId },
      },
      item: {
        id: { needs: { id: true }, compute: (i) => i.id as ItemId },
        projectId: {
          needs: { projectId: true },
          compute: (i) => i.projectId as ProjectId,
        },
        providerItemId: {
          needs: { providerItemId: true },
          compute: (i) => i.providerItemId as ProviderItemId,
        },
        // `parentId` stores the parent's providerItemId, not a surrogate cuid
        // — see the Item.parentId column comment in `prisma/schema.prisma`.
        parentId: {
          needs: { parentId: true },
          compute: (i) => (i.parentId === null ? null : (i.parentId as ProviderItemId)),
        },
      },
      comment: {
        itemId: { needs: { itemId: true }, compute: (c) => c.itemId as ItemId },
      },
      watchlistEntry: {
        userId: { needs: { userId: true }, compute: (w) => w.userId as UserId },
        projectId: {
          needs: { projectId: true },
          compute: (w) => w.projectId as ProjectId,
        },
        providerItemId: {
          needs: { providerItemId: true },
          compute: (w) => w.providerItemId as ProviderItemId,
        },
      },
      savedView: {
        userId: { needs: { userId: true }, compute: (v) => v.userId as UserId },
        projectId: {
          needs: { projectId: true },
          compute: (v) => v.projectId as ProjectId,
        },
      },
      memoryEntry: {
        projectId: {
          needs: { projectId: true },
          compute: (m) => m.projectId as ProjectId,
        },
      },
      sourceDoc: {
        projectId: {
          needs: { projectId: true },
          compute: (s) => s.projectId as ProjectId,
        },
      },
      conversation: {
        id: { needs: { id: true }, compute: (c) => c.id as ConversationId },
        projectId: {
          needs: { projectId: true },
          compute: (c) => c.projectId as ProjectId,
        },
        userId: { needs: { userId: true }, compute: (c) => c.userId as UserId },
        itemId: {
          needs: { itemId: true },
          compute: (c) => (c.itemId === null ? null : (c.itemId as ItemId)),
        },
      },
      message: {
        id: { needs: { id: true }, compute: (m) => m.id as MessageId },
        conversationId: {
          needs: { conversationId: true },
          compute: (m) => m.conversationId as ConversationId,
        },
      },
      proposal: {
        id: { needs: { id: true }, compute: (p) => p.id as ProposalId },
        projectId: {
          needs: { projectId: true },
          compute: (p) => p.projectId as ProjectId,
        },
        userId: { needs: { userId: true }, compute: (p) => p.userId as UserId },
        providerItemId: {
          needs: { providerItemId: true },
          compute: (p) => (p.providerItemId === null ? null : (p.providerItemId as ProviderItemId)),
        },
      },
      mcpServerConfig: {
        projectId: {
          needs: { projectId: true },
          compute: (m) => m.projectId as ProjectId,
        },
      },
      mcpOauthState: {
        projectId: {
          needs: { projectId: true },
          compute: (s) => s.projectId as ProjectId,
        },
        userId: { needs: { userId: true }, compute: (s) => s.userId as UserId },
      },
      setting: {
        userId: {
          needs: { userId: true },
          compute: (s) => (s.userId === null ? null : (s.userId as UserId)),
        },
        projectId: {
          needs: { projectId: true },
          compute: (s) => (s.projectId === null ? null : (s.projectId as ProjectId)),
        },
      },
      suggestion: {
        projectId: {
          needs: { projectId: true },
          compute: (s) => s.projectId as ProjectId,
        },
      },
      commandUsage: {
        userId: { needs: { userId: true }, compute: (c) => c.userId as UserId },
        projectId: {
          needs: { projectId: true },
          compute: (c) => (c.projectId === null ? null : (c.projectId as ProjectId)),
        },
      },
      syncCursor: {
        projectId: {
          needs: { projectId: true },
          compute: (s) => s.projectId as ProjectId,
        },
      },
      audit: {
        projectId: {
          needs: { projectId: true },
          compute: (a) => a.projectId as ProjectId,
        },
        userId: {
          needs: { userId: true },
          compute: (a) => (a.userId === null ? null : (a.userId as UserId)),
        },
        proposalId: {
          needs: { proposalId: true },
          compute: (a) => (a.proposalId === null ? null : (a.proposalId as ProposalId)),
        },
      },
      webFetchEvent: {
        projectId: {
          needs: { projectId: true },
          compute: (w) => w.projectId as ProjectId,
        },
        userId: {
          needs: { userId: true },
          compute: (w) => (w.userId === null ? null : (w.userId as UserId)),
        },
      },
    },
  });
}

type ExtendedClient = ReturnType<typeof makeClient>;

const globalForPrisma = globalThis as unknown as { prisma?: ExtendedClient };

function getClient(): ExtendedClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = makeClient();
  }
  return globalForPrisma.prisma;
}

/**
 * Lazy Prisma client proxy. The actual client is constructed on first property
 * access so importing this module never fails at build time when env vars
 * aren't populated yet (e.g. during `next build`).
 *
 * The proxy target is the *extended* client type — `db.project.findUnique`
 * returns rows with branded id fields (see `makeClient`). Domain code
 * receives `ProjectId` / `UserId` / etc. directly from Prisma; the only
 * places that still mint a brand from a raw string are input boundaries
 * (Zod parse, NextAuth session callback, env / CLI bootstrap).
 */
export const db = new Proxy({} as ExtendedClient, {
  get(_target, prop) {
    return Reflect.get(getClient(), prop);
  },
});
