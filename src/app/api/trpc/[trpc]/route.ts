import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { errFields } from "@/server/log-fields";
import { logger } from "@/server/logger";
import { appRouter } from "@/server/routers";
import { createContext } from "@/server/trpc";

// Every tRPC procedure touches Prisma, NextAuth, or per-request derived
// state; static prerendering would be wrong, and so would Edge runtime
// (Prisma's pg driver adapter needs Node).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Codes that are expected client-facing failures — validation, auth, and
// not-found errors don't need to page the operator. INTERNAL_SERVER_ERROR
// and anything else is a genuine bug or upstream outage and gets logged.
const EXPECTED_CODES = new Set([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "TOO_MANY_REQUESTS",
  "UNPROCESSABLE_CONTENT",
]);

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext,
    onError: ({ error, path, type }) => {
      if (EXPECTED_CODES.has(error.code)) return;
      logger.error(
        { code: error.code, path: path ?? null, type, ...errFields(error) },
        "trpc: unhandled procedure error",
      );
    },
  });

export { handler as GET, handler as POST };
