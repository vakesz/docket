import "server-only";
import { appRouter } from "@/server/routers";
import { createContext } from "@/server/trpc";

/** Server-side tRPC caller for use inside React Server Components. */
export async function createCaller() {
  const ctx = await createContext();
  return appRouter.createCaller(ctx);
}
