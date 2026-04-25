import { createStart } from "@tanstack/react-start";

// Docket is a local-first app: the dev server proxies `/api/*` to the local
// backend, and the prod Bun server does the same. SSR would re-fetch every
// query on the server, then again on the client (no dehydrate/HydrationBoundary
// is wired up), which doubles every load. Disable SSR globally; the app runs
// as a SPA with React Query handling caching.
export const startInstance = createStart(() => ({
  defaultSsr: false,
}));
