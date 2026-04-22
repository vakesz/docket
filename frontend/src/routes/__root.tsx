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
import globalsCss from "~/styles/globals.css?url";

interface RouterContext {
  queryClient: QueryClient;
}

// Applied before React hydrates so <html data-theme> and the `dark` class
// match the user's saved theme on first paint. Mirrors lib/theme.ts logic
// (kept inline + duplicated because this script runs before any module
// loads). Keep the THEMES_DARK list in sync with `THEMES` in lib/theme.ts.
const THEME_BOOTSTRAP = `(() => {
  try {
    var DARK = ["dark","nord","dracula","gruvbox-dark","tokyo-night","catppuccin-mocha"];
    var VALID = ["system","light","dark","nord","dracula","gruvbox-dark","gruvbox-light","tokyo-night","catppuccin-mocha","catppuccin-latte","solarized-light"];
    var s = localStorage.getItem("docket.theme");
    var id = (s && VALID.indexOf(s) !== -1) ? s : "system";
    var resolved = id === "system"
      ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : id;
    var root = document.documentElement;
    root.setAttribute("data-theme", resolved);
    root.classList.toggle("dark", DARK.indexOf(resolved) !== -1);
  } catch (_) {}
})();`;

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Docket" },
    ],
    links: [{ rel: "stylesheet", href: globalsCss }],
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
