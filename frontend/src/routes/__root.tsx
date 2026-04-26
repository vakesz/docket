import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouteContext,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AppShell } from "~/components/common/AppShell";
import { ADAPTIVE_VARIANTS, STORAGE_KEY, THEMES } from "~/lib/theme";
import globalsCss from "~/styles/globals.css?url";

interface RouterContext {
  queryClient: QueryClient;
}

// Applied before React hydrates so <html data-theme> and the `dark` class
// match the user's saved theme on first paint. Built from the canonical
// THEMES / ADAPTIVE_VARIANTS catalog in lib/theme.ts so adding a theme
// there automatically updates the bootstrap.
const DARK_IDS = THEMES.filter((t) => t.dark).map((t) => t.id);
const ADAPTIVE_PAIRS = Object.fromEntries(
  Object.entries(ADAPTIVE_VARIANTS).map(([id, v]) => [id, [v.light, v.dark]]),
);
const VALID_IDS = THEMES.map((t) => t.id);

const THEME_BOOTSTRAP = `(() => {
  try {
    var DARK = ${JSON.stringify(DARK_IDS)};
    var ADAPTIVE = ${JSON.stringify(ADAPTIVE_PAIRS)};
    var VALID = ${JSON.stringify(VALID_IDS)};
    var s = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
    var id = (s && VALID.indexOf(s) !== -1) ? s : "system";
    var resolved;
    if (ADAPTIVE[id]) {
      var prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
      resolved = prefersDark ? ADAPTIVE[id][1] : ADAPTIVE[id][0];
    } else {
      resolved = id;
    }
    var root = document.documentElement;
    root.setAttribute("data-theme", resolved);
    root.classList.toggle("dark", DARK.indexOf(resolved) !== -1);
  } catch (_) {}
})();`;

export const Route = createRootRouteWithContext<RouterContext>()({
  ssr: true,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Docket" },
    ],
    links: [
      { rel: "stylesheet", href: globalsCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
    ],
    scripts: [{ children: THEME_BOOTSTRAP }],
  }),
  component: RootComponent,
});

function RootComponent() {
  const { queryClient } = useRouteContext({ from: "__root__" });
  return (
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <AppShell>
          <Outlet />
        </AppShell>
      </QueryClientProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
