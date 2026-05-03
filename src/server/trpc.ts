import "server-only";
import { initTRPC, TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import type { Session } from "next-auth";
import superjson from "superjson";
import { ZodError, z } from "zod";
import type { UserId } from "@/core/types";
import { db } from "@/db";
import { projectMemberships } from "@/db/schema";
import { auth } from "@/server/auth";
import { assertFound } from "@/server/errors";
import { logger } from "@/server/logger";
import { type AuthorizedProject, projectForUser } from "@/server/projects/access";
import type { SettingKey, SettingValue } from "@/server/settings/catalog";
import { loadGlobalSetting } from "@/server/settings/effective";
import { ensureSchedulerRunning } from "@/server/sync/scheduler";

export { assertFound };

export type Context = {
  session: Session | null;
  db: typeof db;
  log: typeof logger;
  /**
   * Per-request memo for global Settings reads. tRPC batches multiple
   * procedures through a single createContext() call, so any middleware
   * (e.g. the read-only gate that runs on every mutation) hits the DB once
   * per HTTP request instead of once per procedure.
   *
   * Stored as `unknown` because TS's mapped types can't track per-key value
   * types through a Map's generic API. The single cast lives in
   * `getGlobalSettingCached` below — at the read boundary, where the
   * generic K is in scope and the `SettingValue<K>` invariant is honored
   * by construction (we only ever store what `loadGlobalSetting` returns).
   */
  globalSettings: Map<SettingKey, unknown>;
};

export async function createContext(): Promise<Context> {
  const session = await auth();
  // Lazy-start the server-side sync scheduler on first authenticated
  // request. Idempotent; safe to call here. Skipped during `next build`
  // because that flow doesn't construct authenticated tRPC contexts.
  if (session?.user) ensureSchedulerRunning();
  return {
    session,
    db,
    log: logger,
    globalSettings: new Map(),
  };
}

async function getGlobalSettingCached<K extends SettingKey>(
  ctx: Context,
  key: K,
): Promise<SettingValue<K>> {
  if (ctx.globalSettings.has(key)) {
    return ctx.globalSettings.get(key) as SettingValue<K>;
  }
  const value = await loadGlobalSetting(ctx.db, key);
  ctx.globalSettings.set(key, value);
  return value;
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.code === "BAD_REQUEST" && error.cause instanceof ZodError
            ? error.cause.flatten()
            : null,
      },
    };
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const publicProcedure = t.procedure;

/**
 * Shared zod fragment for project-scoped procedure inputs. Compose via
 * `.extend({ ... })` so every router uses the same identifier rule and
 * rename stays single-source.
 *
 * The wire field is `projectSlug` — that's the URL-facing identifier. The
 * resolved CUID is exposed downstream as `ctx.projectId` for FK queries.
 */
export const projectSlugSchema = z.object({ projectSlug: z.string().min(1) });

const requireSession = t.middleware(({ ctx, next }) => {
  if (!ctx.session?.user?.id) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      userId: ctx.session.user.id,
      session: ctx.session,
    },
  });
});

/** Authenticated procedure: requires a valid NextAuth session. */
export const protectedProcedure = t.procedure.use(requireSession);

/**
 * System-wide read-only gate. Reads the `app.read-only` global Setting on
 * every mutation and refuses if it's on. Backed by `ctx.globalSettings` so
 * batched mutations within one HTTP request only query the table once.
 */
const enforceReadWrite = t.middleware(async ({ ctx, next }) => {
  const readOnly = await getGlobalSettingCached(ctx, "app.read-only");
  if (readOnly) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "system is in read-only mode — mutations are blocked",
    });
  }
  return next();
});

/**
 * Mutating procedure: protected + system read-only gate. Project-scoped
 * mutations get the role check on top.
 */
export const mutationProcedure = protectedProcedure.use(enforceReadWrite);

/**
 * Project-scoped procedure: requires `projectSlug` in the input and verifies
 * the session user owns the project or has a membership on it. Injects
 * `project` and `projectId` (the resolved CUID, used for FK queries) into
 * ctx for downstream use.
 *
 * Procedures that compose this MUST .input() a Zod schema that includes
 * `projectSlug: z.string()` — the middleware reads it via getRawInput().
 *
 * Defined as an inline `.use(...)` on `protectedProcedure` so the chained
 * context inference picks up `ctx.userId` from `requireSession` upstream
 * without a manual cast.
 */
export const projectScopedProcedure = protectedProcedure.use(async ({ ctx, getRawInput, next }) => {
  const raw = await getRawInput();
  const parsed = z.object({ projectSlug: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "projectSlug is required for project-scoped procedures",
    });
  }

  const project = await projectForUser(ctx.db, parsed.data.projectSlug, ctx.userId);
  if (!project) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "no access to this project",
    });
  }

  return next({
    ctx: {
      projectId: project.id,
      project,
    },
  });
});

/**
 * Look up the caller's effective role on `ctx.project`. Owners are reported
 * as `'owner'` (a synthetic role above `approver`); members surface their
 * stored role; users with no membership row return `null`.
 */
async function effectiveProjectRole(
  ctx: Context & { userId: UserId; project: AuthorizedProject },
): Promise<"owner" | "approver" | "member" | "viewer" | null> {
  if (ctx.project.ownerUserId === ctx.userId) return "owner";
  const membership = await ctx.db.query.projectMemberships.findFirst({
    where: and(
      eq(projectMemberships.projectId, ctx.project.id),
      eq(projectMemberships.userId, ctx.userId),
    ),
    columns: { role: true },
  });
  if (!membership) return null;
  if (membership.role === "approver") return "approver";
  if (membership.role === "viewer") return "viewer";
  return "member";
}

/**
 * Mutating, project-scoped procedure. Owners always pass; non-owner members
 * must have a role other than `viewer`. Layers the system-wide read-only
 * gate so a single toggle can lock the whole app.
 */
export const projectScopedMutationProcedure = projectScopedProcedure
  .use(enforceReadWrite)
  .use(async ({ ctx, next }) => {
    const role = await effectiveProjectRole(ctx);
    if (role === "viewer" || role === null) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "viewers cannot perform mutations on this project",
      });
    }
    return next();
  });

/**
 * Approver-or-owner gate for confirming/rejecting proposals. Non-owner
 * members with role `member` (or below) can stage proposals but can't
 * execute them — the human-in-the-loop on writes.
 */
export const projectScopedApproverProcedure = projectScopedMutationProcedure.use(
  async ({ ctx, next }) => {
    const role = await effectiveProjectRole(ctx);
    if (role !== "owner" && role !== "approver") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "only project owners and approvers can confirm or reject proposals",
      });
    }
    return next();
  },
);
