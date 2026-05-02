import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Prefer .env.local for dev, fall back to .env for production self-host.
// Both are loaded so a missing key in one is filled by the other.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
}

export default defineConfig({
  schema: "./src/db/schema",
  out: "./drizzle",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: { url: databaseUrl },
  verbose: true,
  strict: true,
  breakpoints: true,
});
