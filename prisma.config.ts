import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// Prefer .env.local for dev, fall back to .env for production self-host.
// Both are loaded so a missing key in one is filled by the other.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
