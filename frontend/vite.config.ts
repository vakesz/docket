import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { resolveBackendConfig } from "./resolve-backend-config";

/**
 * Dev: vite serves the SPA at :3000 with HMR. /api/* proxies to the backend
 * (DOCKET_API_URL, default 127.0.0.1:8765). The bearer token is injected into
 * `index.html` as `window.__DOCKET_TOKEN__` so the same auth path works in
 * dev and prod — see resolve-backend-config.ts for token precedence.
 *
 * Prod: `bun run build` emits a static SPA in `dist/`. The Python backend
 * (`docket serve`) serves it directly and injects the token at request time.
 */
const { apiUrl: apiTarget, apiToken } = resolveBackendConfig();

function injectDevToken(token: string): Plugin {
  return {
    name: "docket-inject-dev-token",
    apply: "serve",
    transformIndexHtml() {
      const safe = JSON.stringify(token);
      return [
        {
          tag: "script",
          children: `window.__DOCKET_TOKEN__=${safe};`,
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 3000,
    host: "0.0.0.0",
    proxy: {
      // Backend natively exposes /api/* — no rewrite needed.
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
  plugins: [
    tailwindcss(),
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    viteReact(),
    injectDevToken(apiToken),
  ],
});
