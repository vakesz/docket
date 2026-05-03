import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { decimal4, pkUuid, timestamps } from "@/db/columns";

// LlmProvider rows feed two disjoint resolvers — chat and guardrail. The
// agent loop picks chat rows; the guardrail pipeline picks guardrail rows.
// Role is stamped at create time and is not editable; to switch, delete and
// recreate the row.

export type LlmProviderRole = "chat" | "guardrail";

export const llmProviders = pgTable(
  "llm_providers",
  {
    id: pkUuid(),
    // 'openai' | future vendors ('anthropic', 'gemini', 'bedrock', 'mistral',
    // 'ollama', ...). The agent's `selectAdapterFor` dispatches on this.
    // Open-extensibility column — no CHECK constraint.
    kind: text().notNull(),
    role: text().$type<LlmProviderRole>().notNull().default("chat"),
    label: text().notNull(),
    // AES-256-GCM ciphertext (`enc:v1:<iv>:<ct+tag>`).
    apiKey: text().notNull(),
    // Default model for this provider row. Empty falls back to the adapter's
    // hardcoded default for that role.
    model: text().notNull().default(""),
    // Optional base URL (Azure AI Foundry, Ollama, proxies). Empty = default.
    baseUrl: text().notNull().default(""),
    // Per-million-tokens prompt-side price in USD cents. Null = unknown.
    // Stored as Decimal(12, 4); reads convert to `number` at the boundary.
    inputPriceCentsPerMtok: decimal4(),
    outputPriceCentsPerMtok: decimal4(),
    isDefault: boolean().notNull().default(false),
    enabled: boolean().notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    check("llm_providers_role_check", sql`${t.role} IN ('chat', 'guardrail')`),
    index("llm_providers_kind_idx").on(t.kind),
    // [role, isDefault] also serves single-column lookups on `role` because
    // PostgreSQL B-tree indexes can be probed by a leading-column subset of
    // their key.
    index("llm_providers_role_is_default_idx").on(t.role, t.isDefault),
    // At most one default per role. The `setDefault` / `create` flows clear
    // existing defaults inside a transaction, but a partial-unique index
    // hardens the invariant against direct DB writes and concurrent paths
    // racing without the right WHERE filter.
    uniqueIndex("llm_providers_role_default_unique_idx")
      .on(t.role)
      .where(sql`${t.isDefault} = TRUE`),
  ],
);
