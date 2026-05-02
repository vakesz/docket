import type { Metadata } from "next";
import { Geist_Mono, Outfit } from "next/font/google";
import { AppProviders } from "@/app/providers";
import { publicBaseUrl } from "@/lib/public-base-url";
import { Toaster } from "@/ui/primitives/sonner";
import { ThemeProvider } from "@/ui/shell/theme-provider";
import "./globals.css";
import "./app.css";

// next/font self-hosts Google Fonts at build time and inlines a
// font-display: swap stylesheet, eliminating the render-blocking
// `@import url(fonts.googleapis.com/...)` round-trip and the FOUT it
// caused. The CSS variables here override the family names the tweakcn
// theme tokens reference in `globals.css` (`--font-sans` / `--font-mono`).
const fontSans = Outfit({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

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
    <html
      lang="en"
      className={`h-full antialiased ${fontSans.variable} ${fontMono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex h-full flex-col overflow-hidden bg-background font-sans text-foreground">
        <ThemeProvider>
          <AppProviders>{children}</AppProviders>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
