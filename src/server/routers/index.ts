import { conversationsRouter } from "@/server/conversations/router";
import { itemsRouter } from "@/server/items/router";
import { llmProvidersRouter } from "@/server/llm/router";
import { projectsRouter } from "@/server/projects/router";
import { proposalsRouter } from "@/server/proposals/router";
import { healthRouter } from "@/server/routers/health";
import { router } from "@/server/trpc";
import { watchlistRouter } from "@/server/watchlist/router";

export const appRouter = router({
  health: healthRouter,
  projects: projectsRouter,
  llmProviders: llmProvidersRouter,
  items: itemsRouter,
  proposals: proposalsRouter,
  conversations: conversationsRouter,
  watchlist: watchlistRouter,
});

export type AppRouter = typeof appRouter;
