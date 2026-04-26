import { publicProcedure, router } from "@/server/trpc";

export const healthRouter = router({
  ping: publicProcedure.query(() => "ok" as const),
});
