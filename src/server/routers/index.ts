import { itemsRouter } from "@/server/items/router";
import { llmProvidersRouter } from "@/server/llm/router";
import { projectsRouter } from "@/server/projects/router";
import { proposalsRouter } from "@/server/proposals/router";
import { healthRouter } from "@/server/routers/health";
import { router } from "@/server/trpc";

export const appRouter = router({
  health: healthRouter,
  projects: projectsRouter,
  llmProviders: llmProvidersRouter,
  items: itemsRouter,
  proposals: proposalsRouter,
});

export type AppRouter = typeof appRouter;
