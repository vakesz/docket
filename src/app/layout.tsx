import type { Metadata } from "next";
import { AppProviders } from "@/app/providers";
import { publicBaseUrl } from "@/lib/public-base-url";
import { Toaster } from "@/ui/primitives/sonner";
import { ThemeProvider } from "@/ui/shell/theme-provider";
import "./globals.css";
import "./app.css";

export const metadata: Metadata = {
  // `template` lets child pages export `title: "Foo"` and have Next stitch
  // in the suffix; `default` covers routes that don't set their own title.
  title: { default: "docket", template: "%s — docket" },
  description: "Provider-agnostic project tracker",
  // metadataBase resolves any future relative `og:image` / `twitter:image`
  // entries declared on a child page. Falls back to localhost in dev.
  metadataBase: new URL(publicBaseUrl()),
};

// Every page in the app touches the DB (auth, setup status, project data),
// so static prerendering at `next build` time has nothing useful to do and
// would crash on the lazy DB proxy when DATABASE_URL isn't set in the build
// environment. Keep everything request-time.
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="h-full flex flex-col overflow-hidden bg-background font-sans text-foreground">
        <ThemeProvider>
          <AppProviders>{children}</AppProviders>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
