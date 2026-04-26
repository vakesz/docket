import "server-only";
import { initTRPC, TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import superjson from "superjson";
import { ZodError, z } from "zod";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { logger } from "@/server/logger";

export type Context = {
  session: Session | null;
  db: typeof db;
  log: typeof logger;
};

export async function createContext(): Promise<Context> {
  const session = (await auth()) as Session | null;
  return {
    session,
    db,
    log: logger,
  };
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

const requireSession = t.middleware(({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      session: { ...ctx.session, user: ctx.session.user },
    },
  });
});

/** Authenticated procedure: requires a valid NextAuth session. */
export const protectedProcedure = t.procedure.use(requireSession);

/**
 * Mutating procedure: same as protected today; Phase 10 adds the role check
 * (rejects `viewer`) and read-only-mode gate.
 */
export const mutationProcedure = protectedProcedure;

/**
 * Project-scoped procedure: requires `projectId` in the input and verifies
 * the session user owns the project or has a membership on it. Injects
 * `project` and `projectId` into ctx for downstream use.
 *
 * Procedures that compose this MUST .input() a Zod schema that includes
 * `projectId: z.string()` — the middleware reads it via getRawInput().
 */
const enforceProjectMembership = t.middleware(async ({ ctx, getRawInput, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  const userId = ctx.session.user.id;
  if (!userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "session has no user id" });
  }

  const raw = await getRawInput();
  const parsed = z.object({ projectId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "projectId is required for project-scoped procedures",
    });
  }

  const project = await ctx.db.project.findFirst({
    where: {
      id: parsed.data.projectId,
      archivedAt: null,
      OR: [{ ownerUserId: userId }, { memberships: { some: { userId } } }],
    },
  });
  if (!project) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "no access to this project",
    });
  }

  return next({
    ctx: {
      ...ctx,
      session: { ...ctx.session, user: ctx.session.user },
      projectId: project.id,
      project,
    },
  });
});

export const projectScopedProcedure = protectedProcedure.use(enforceProjectMembership);
