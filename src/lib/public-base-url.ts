/**
 * Resolve the public-facing base URL of the running app.
 *
 * `PUBLIC_BASE_URL` is the deployment-time hint operators set when the app
 * sits behind a reverse proxy or CDN — it should be the URL a logged-in user
 * actually types in their browser. The dev fallback is `http://localhost:<PORT>`,
 * matching `bun run dev`.
 *
 * Used for: OAuth callback URLs (settings panel), metadataBase in the root
 * layout, and the tRPC client URL when running on the server.
 *
 * Server-only at runtime: `PUBLIC_BASE_URL` and `PORT` aren't `NEXT_PUBLIC_`
 * prefixed, so on the client they're stripped from the bundle and the
 * function would silently return `http://localhost:3000`. The module is
 * imported by client components (`app/providers.tsx`) but only *called*
 * inside a `typeof window === "undefined"` branch — we can't add
 * `server-only` because that would break the build, but we DO refuse to
 * run on the client so an accidental call surfaces immediately instead
 * of returning a wrong URL.
 */
export function publicBaseUrl(): string {
  if (typeof window !== "undefined") {
    throw new Error("publicBaseUrl() must only be called on the server");
  }
  return (
    process.env["PUBLIC_BASE_URL"] ?? `http://localhost:${process.env["PORT"] ?? 3000}`
  ).trim();
}
