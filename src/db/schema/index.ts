// Re-export every table + relations block as a single namespace. Drizzle's
// query API needs every table and every `relations()` block in one schema
// object so it can wire up the `with: { ... }` graph; this file is that one
// object. Consumers `import { items, comments, ... } from "@/db/schema"`.

export * from "@/db/schema/audit";
export * from "@/db/schema/auth";
export * from "@/db/schema/avatars";
export * from "@/db/schema/command-usage";
export * from "@/db/schema/conversations";
export * from "@/db/schema/items";
export * from "@/db/schema/llm";
export * from "@/db/schema/mcp";
export * from "@/db/schema/memory";
export * from "@/db/schema/oauth";
export * from "@/db/schema/projects";
export * from "@/db/schema/proposals";
export * from "@/db/schema/settings";
export * from "@/db/schema/sources";
export * from "@/db/schema/suggestions";
export * from "@/db/schema/sync";
export * from "@/db/schema/views";
export * from "@/db/schema/watchlist";
export * from "@/db/schema/web-fetch";
