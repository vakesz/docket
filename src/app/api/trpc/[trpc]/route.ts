import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/routers";
import { createContext } from "@/server/trpc";

// Every tRPC procedure touches Prisma, NextAuth, or per-request derived
// state; static prerendering would be wrong, and so would Edge runtime
// (Prisma's pg driver adapter needs Node).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext,
  });

export { handler as GET, handler as POST };
