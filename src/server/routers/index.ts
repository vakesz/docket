import { analyticsRouter } from "@/server/analytics/router";
import { conversationsRouter } from "@/server/conversations/router";
import { itemsRouter } from "@/server/items/router";
import { llmProvidersRouter } from "@/server/llm/router";
import { mcpRouter } from "@/server/mcp/router";
import { memoryRouter } from "@/server/memory/router";
import { oauthProvidersRouter } from "@/server/oauth/router";
import { projectsRouter } from "@/server/projects/router";
import { proposalsRouter } from "@/server/proposals/router";
import { healthRouter } from "@/server/routers/health";
import { settingsRouter } from "@/server/settings/router";
import { sourcesRouter } from "@/server/sources/router";
import { suggestionsRouter } from "@/server/suggestions/router";
import { router } from "@/server/trpc";
import { viewsRouter } from "@/server/views/router";
import { watchlistRouter } from "@/server/watchlist/router";

export const appRouter = router({
  health: healthRouter,
  projects: projectsRouter,
  llmProviders: llmProvidersRouter,
  oauthProviders: oauthProvidersRouter,
  items: itemsRouter,
  proposals: proposalsRouter,
  conversations: conversationsRouter,
  watchlist: watchlistRouter,
  memory: memoryRouter,
  sources: sourcesRouter,
  mcp: mcpRouter,
  views: viewsRouter,
  settings: settingsRouter,
  suggestions: suggestionsRouter,
  analytics: analyticsRouter,
});

export type AppRouter = typeof appRouter;
