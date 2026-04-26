import { llmProvidersRouter } from "@/server/llm/router";
import { projectsRouter } from "@/server/projects/router";
import { healthRouter } from "@/server/routers/health";
import { router } from "@/server/trpc";

export const appRouter = router({
  health: healthRouter,
  projects: projectsRouter,
  llmProviders: llmProvidersRouter,
});

export type AppRouter = typeof appRouter;
