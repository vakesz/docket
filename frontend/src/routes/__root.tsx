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

// Applied before React hydrates so the <html> class matches the user's theme
// on first paint. Reads the same localStorage key as ThemeToggle; when absent
// (or set to "system"), follows `prefers-color-scheme`.
const THEME_BOOTSTRAP = `(() => {
  try {
    var s = localStorage.getItem("docket.theme");
    var d = s === "dark" || ((s !== "light") && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", d);
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
