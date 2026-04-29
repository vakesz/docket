import "server-only";
import { initTRPC, TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import superjson from "superjson";
import { ZodError, z } from "zod";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { projectForUser } from "@/server/projects/access";
import type { SettingKey, SettingValue } from "@/server/settings/catalog";
import { loadGlobalSetting } from "@/server/settings/effective";

export type Context = {
  session: Session | null;
  db: typeof db;
  log: typeof logger;
  /**
   * Per-request memo for global Settings reads. tRPC batches multiple
   * procedures through a single createContext() call, so any middleware
   * (e.g. the read-only gate that runs on every mutation) hits the DB once
   * per HTTP request instead of once per procedure.
   */
  globalSettings: Map<SettingKey, unknown>;
};

export async function createContext(): Promise<Context> {
  const session = (await auth()) as Session | null;
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
 * `.extend({ ... })` so every router uses the same id rule and rename
 * stays single-source.
 */
export const projectIdSchema = z.object({ projectId: z.string().min(1) });

/**
 * Generic NOT_FOUND assertion for router handlers. Use whenever a Prisma
 * lookup may return null and the router should surface a 404 to the client
 * rather than letting `undefined` leak into a downstream call.
 */
export function assertFound<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message });
  }
  return value;
}

const requireSession = t.middleware(({ ctx, next }) => {
  const userId = ctx.session?.user?.id;
  if (!ctx.session?.user || !userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      userId,
      session: {
        ...ctx.session,
        user: { ...ctx.session.user, id: userId },
      },
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
 * Project-scoped procedure: requires `projectId` in the input and verifies
 * the session user owns the project or has a membership on it. Injects
 * `project` and `projectId` into ctx for downstream use.
 *
 * Procedures that compose this MUST .input() a Zod schema that includes
 * `projectId: z.string()` — the middleware reads it via getRawInput().
 */
const enforceProjectMembership = t.middleware(async ({ ctx, getRawInput, next }) => {
  // `requireSession` runs upstream and narrows ctx.userId to a non-empty string.
  const sessionCtx = ctx as Context & { userId?: string };
  const userId = sessionCtx.userId;
  if (!userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  const raw = await getRawInput();
  const parsed = z.object({ projectId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "projectId is required for project-scoped procedures",
    });
  }

  const project = await projectForUser(ctx.db, parsed.data.projectId, userId);
  if (!project) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "no access to this project",
    });
  }

  return next({
    ctx: {
      ...ctx,
      projectId: project.id,
      project,
    },
  });
});

export const projectScopedProcedure = protectedProcedure.use(enforceProjectMembership);

/**
 * Look up the caller's effective role on `ctx.project`. Owners are reported
 * as `'owner'` (a synthetic role above `approver`); members surface their
 * stored role; users with no membership row return `null`.
 */
async function effectiveProjectRole(
  ctx: Context & { userId?: string; project?: { id: string; ownerUserId: string } },
): Promise<"owner" | "approver" | "member" | "viewer" | null> {
  const project = ctx.project;
  const userId = ctx.userId;
  if (!project || !userId) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "effectiveProjectRole requires projectScopedProcedure upstream",
    });
  }
  if (project.ownerUserId === userId) return "owner";
  const membership = await ctx.db.projectMembership.findUnique({
    where: { projectId_userId: { projectId: project.id, userId } },
    select: { role: true },
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
const rejectViewerRole = t.middleware(async ({ ctx, next }) => {
  const role = await effectiveProjectRole(
    ctx as Context & { project?: { id: string; ownerUserId: string } },
  );
  if (role === "viewer" || role === null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "viewers cannot perform mutations on this project",
    });
  }
  return next();
});

export const projectScopedMutationProcedure = projectScopedProcedure
  .use(enforceReadWrite)
  .use(rejectViewerRole);

/**
 * Approver-or-owner gate for confirming/rejecting proposals. Non-owner
 * members with role `member` (or below) can stage proposals but can't
 * execute them — the human-in-the-loop on writes.
 */
const requireApprover = t.middleware(async ({ ctx, next }) => {
  const role = await effectiveProjectRole(
    ctx as Context & { project?: { id: string; ownerUserId: string } },
  );
  if (role !== "owner" && role !== "approver") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "only project owners and approvers can confirm or reject proposals",
    });
  }
  return next();
});

export const projectScopedApproverProcedure = projectScopedMutationProcedure.use(requireApprover);
