/**
 * Production Bun server for the Docket frontend.
 *
 *   - `/api/*`  →  proxies to DOCKET_API_URL with a bearer token injected from
 *                  DOCKET_API_TOKEN (the token never leaves the server process).
 *   - `/assets/*` and other built files are served from `dist/client/`.
 *   - Everything else is handed to the TanStack Start SSR handler in
 *     `dist/server/server.js` (which re-renders the React app).
 *
 * Start with `bun run server.ts` (see package.json "start") after
 * `bun run build` has produced `dist/`.
 */
import { statSync } from "node:fs";
import { join, normalize } from "node:path";

// @ts-expect-error — built artifact exists after `bun run build`.
import ssrHandler from "./dist/server/server.js";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const API_TARGET = process.env.DOCKET_API_URL ?? "http://127.0.0.1:8765";
const API_TOKEN = process.env.DOCKET_API_TOKEN ?? "";
const CLIENT_DIR = join(import.meta.dir, "dist", "client");

if (!API_TOKEN) {
  console.warn("[docket-frontend] DOCKET_API_TOKEN is empty — /api/* requests will be unauthenticated.");
}

async function proxyApi(req: Request): Promise<Response> {
  const inUrl = new URL(req.url);
  const target = new URL(API_TARGET);
  target.pathname = inUrl.pathname.replace(/^\/api/, "") || "/";
  target.search = inUrl.search;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("connection");
  if (API_TOKEN) headers.set("authorization", `Bearer ${API_TOKEN}`);

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    body:
      req.method === "GET" || req.method === "HEAD" ? undefined : (req.body ?? undefined),
    redirect: "manual",
  };
  if (init.body) init.duplex = "half";

  return fetch(target.toString(), init);
}

function tryStatic(pathname: string): Response | null {
  const rel = normalize(pathname).replace(/^[/\\]+/, "");
  if (rel.includes("..")) return null;
  const abs = join(CLIENT_DIR, rel);
  try {
    const stat = statSync(abs);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  return new Response(Bun.file(abs));
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") return new Response("ok");

    if (url.pathname.startsWith("/api/")) {
      try {
        return await proxyApi(req);
      } catch (err) {
        return new Response(`upstream unreachable: ${(err as Error).message}`, {
          status: 502,
        });
      }
    }

    const staticRes = tryStatic(url.pathname);
    if (staticRes) return staticRes;

    return ssrHandler.fetch(req);
  },
});

console.log(`[docket-frontend] ready on http://${server.hostname}:${server.port} → ${API_TARGET}`);
