import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // `server-only` throws unconditionally outside a Next.js RSC bundler
      // condition. Tests run in plain node, so stub it to a no-op.
      "server-only": path.resolve(__dirname, "./src/test/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts"],
    exclude: ["node_modules", ".next"],
    typecheck: {
      enabled: false,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/server/proposals/**", "src/agent/tools/**"],
      exclude: ["**/*.test.ts", "**/*.test.tsx"],
      thresholds: {
        "src/server/proposals/**": {
          lines: 70,
          functions: 70,
          statements: 70,
          branches: 60,
        },
        "src/agent/tools/**": {
          lines: 60,
          functions: 60,
          statements: 60,
          branches: 50,
        },
      },
    },
  },
});
