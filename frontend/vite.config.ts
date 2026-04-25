import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolveBackendConfig } from "./resolve-backend-config";

/**
 * Dev proxy attaches the bearer token so the browser can talk to `/api/*`
 * without ever seeing the credential. Prod serving is wrapped by `server.ts`.
 * The token comes from `config.toml` (post-setup) or `DOCKET_API_TOKEN` as an
 * override — see `resolve-backend-config.ts` for the full precedence.
 */
const { apiUrl: apiTarget, apiToken } = resolveBackendConfig();

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 3000,
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => {
            if (apiToken) req.setHeader("authorization", `Bearer ${apiToken}`);
          });
        },
      },
    },
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
