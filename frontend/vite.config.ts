import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Dev proxy attaches the bearer token so the browser can talk to `/api/*`
 * without ever seeing the credential. Prod serving is wrapped by `server.ts`.
 */
const apiTarget = process.env.DOCKET_API_URL ?? "http://127.0.0.1:8765";
const apiToken = process.env.DOCKET_API_TOKEN ?? "";

export default defineConfig({
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
  plugins: [tsconfigPaths(), tailwindcss(), tanstackStart(), viteReact()],
});
