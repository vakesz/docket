import "server-only";
import { initTRPC, TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import superjson from "superjson";
import { ZodError } from "zod";
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

/** Mutating procedure: in Phase 10 this also rejects `viewer` role. */
export const mutationProcedure = protectedProcedure;
