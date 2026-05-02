// Module is imported (transitively) by client components, so we can't tag
// it `server-only`. Both env vars are non-`NEXT_PUBLIC_` and the bundler
// strips them from the client; without this throw the function would
// silently return `http://localhost:3000` in the browser.
export function publicBaseUrl(): string {
  if (typeof window !== "undefined") {
    throw new Error("publicBaseUrl() must only be called on the server");
  }
  return (
    process.env["PUBLIC_BASE_URL"] ?? `http://localhost:${process.env["PORT"] ?? 3000}`
  ).trim();
}
