import { relations, sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ConversationId, ItemId, MessageId, ProjectId, UserId } from "@/core/types";
import { cents, fkUuid, optionalFkUuid, pkUuid } from "@/db/columns";
import { users } from "@/db/schema/auth";
import { items } from "@/db/schema/items";
import { llmProviders } from "@/db/schema/llm";
import { projects } from "@/db/schema/projects";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export const conversations = pgTable(
  "conversations",
  {
    id: pkUuid<ConversationId>(),
    projectId: fkUuid<ProjectId>(() => projects.id, "cascade"),
    userId: fkUuid<UserId>(() => users.id, "cascade"),
    // Optional item this conversation hangs off (project-wide chat when null).
    itemId: optionalFkUuid<ItemId>(() => items.id, "set null"),
    // Per-conversation LLM override; null falls back to project default.
    llmProviderIdOverride: optionalFkUuid(() => llmProviders.id, "set null"),
    startedAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
    tokensIn: cents(),
    tokensOut: cents(),
    costCents: cents(),
    // Guardrail spend, tracked separately from chat spend so the analytics
    // chart can split them. Pattern / no-op guardrails leave these at zero.
    guardrailTokensIn: cents(),
    guardrailTokensOut: cents(),
    guardrailCostCents: cents(),
  },
  (t) => [
    index("conversations_project_idx").on(t.projectId),
    index("conversations_user_idx").on(t.userId),
    // Hot path for sync's `activeConversationsForItem`.
    index("conversations_item_idx").on(t.itemId),
    // Budget rollup + analytics aggregate filter by `startedAt` across every
    // project (`startedAt: { gte: since }`).
    index("conversations_started_at_idx").on(t.startedAt),
    index("conversations_llm_override_idx").on(t.llmProviderIdOverride),
  ],
);

// Drizzle's type-inference for `toolCallsJson` is intentionally loose — the
// agent layer narrows it via Zod when reading.
export type MessageToolCallsJson = unknown;

export const messages = pgTable(
  "messages",
  {
    id: pkUuid<MessageId>(),
    conversationId: fkUuid<ConversationId>(() => conversations.id, "cascade"),
    role: text().$type<MessageRole>().notNull(),
    content: text().notNull(),
    // Vendor-neutral discriminated tool-call payload.
    toolCallsJson: jsonb().$type<MessageToolCallsJson>(),
    toolCallId: text(),
    toolName: text(),
    // True after the compaction service has folded this message into a
    // synthetic system summary. Live transcript filters compacted == false.
    compacted: boolean().notNull().default(false),
    pending: boolean().notNull().default(false),
    flagged: boolean().notNull().default(false),
    guardrailReason: text(),
    tokensIn: cents(),
    tokensOut: cents(),
    createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    check("messages_role_check", sql`${t.role} IN ('system', 'user', 'assistant', 'tool')`),
    index("messages_conversation_created_at_idx").on(t.conversationId, t.createdAt),
    index("messages_conversation_compacted_created_at_idx").on(
      t.conversationId,
      t.compacted,
      t.createdAt,
    ),
  ],
);

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  project: one(projects, {
    fields: [conversations.projectId],
    references: [projects.id],
  }),
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
  item: one(items, { fields: [conversations.itemId], references: [items.id] }),
  llmOverride: one(llmProviders, {
    fields: [conversations.llmProviderIdOverride],
    references: [llmProviders.id],
    relationName: "conversationLlmOverride",
  }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));
