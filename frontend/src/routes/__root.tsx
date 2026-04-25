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
// loads). Keep the DARK / ADAPTIVE / VALID lists in sync with `THEMES`
// and `ADAPTIVE_VARIANTS` in lib/theme.ts.
const THEME_BOOTSTRAP = `(() => {
  try {
    var DARK = ["dark","nord","dracula","gruvbox-dark","tokyo-night","monokai","catppuccin-mocha","catppuccin-frappe","catppuccin-macchiato","solarized-dark","rose-pine","rose-pine-moon","atom-one-dark","flexoki-dark"];
    var ADAPTIVE = {
      "system": ["light","dark"],
      "catppuccin": ["catppuccin-latte","catppuccin-mocha"],
      "gruvbox": ["gruvbox-light","gruvbox-dark"],
      "solarized": ["solarized-light","solarized-dark"],
      "rose-pine-auto": ["rose-pine-dawn","rose-pine"],
      "atom-one": ["atom-one-light","atom-one-dark"],
      "flexoki": ["flexoki-light","flexoki-dark"]
    };
    var VALID = ["system","catppuccin","gruvbox","solarized","rose-pine-auto","atom-one","flexoki","light","gruvbox-light","catppuccin-latte","solarized-light","rose-pine-dawn","atom-one-light","flexoki-light","dark","nord","dracula","gruvbox-dark","tokyo-night","monokai","catppuccin-mocha","catppuccin-frappe","catppuccin-macchiato","solarized-dark","rose-pine","rose-pine-moon","atom-one-dark","flexoki-dark"];
    var s = localStorage.getItem("docket.theme");
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
