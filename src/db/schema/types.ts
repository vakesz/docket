// Row-shape aliases. Every consumer imports from `@/db/schema/types` rather
// than reaching into individual schema files for `$inferSelect` / `$inferInsert`,
// keeping the barrel one-file-deep. Insert-side variants live next to their
// select-side aliases so a renaming pass touches both at once.

import type {
  accounts,
  audits,
  avatars,
  commandUsage,
  comments,
  conversations,
  items,
  llmProviders,
  mcpOauthStates,
  mcpServerConfigs,
  memoryEntries,
  messages,
  oauthProviderConfigs,
  projectMemberships,
  projects,
  proposals,
  savedViews,
  sessions,
  settings,
  sourceDocs,
  suggestions,
  syncCursors,
  users,
  verificationTokens,
  watchlistEntries,
  webFetchEvents,
} from "@/db/schema";

// NextAuth
export type User = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type AccountInsert = typeof accounts.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type VerificationToken = typeof verificationTokens.$inferSelect;
export type VerificationTokenInsert = typeof verificationTokens.$inferInsert;

// OAuth + LLM config
export type OauthProviderConfig = typeof oauthProviderConfigs.$inferSelect;
export type OauthProviderConfigInsert = typeof oauthProviderConfigs.$inferInsert;
export type LlmProvider = typeof llmProviders.$inferSelect;
export type LlmProviderInsert = typeof llmProviders.$inferInsert;

// Multi-tenancy
export type Project = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
export type ProjectMembership = typeof projectMemberships.$inferSelect;
export type ProjectMembershipInsert = typeof projectMemberships.$inferInsert;

// Item cache + comments
export type Item = typeof items.$inferSelect;
export type ItemInsert = typeof items.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type CommentInsert = typeof comments.$inferInsert;

// Watchlist + saved views
export type WatchlistEntry = typeof watchlistEntries.$inferSelect;
export type WatchlistEntryInsert = typeof watchlistEntries.$inferInsert;
export type SavedView = typeof savedViews.$inferSelect;
export type SavedViewInsert = typeof savedViews.$inferInsert;

// Memory + sources
export type MemoryEntry = typeof memoryEntries.$inferSelect;
export type MemoryEntryInsert = typeof memoryEntries.$inferInsert;
export type SourceDoc = typeof sourceDocs.$inferSelect;
export type SourceDocInsert = typeof sourceDocs.$inferInsert;

// Conversations
export type Conversation = typeof conversations.$inferSelect;
export type ConversationInsert = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type MessageInsert = typeof messages.$inferInsert;

// Proposals
export type Proposal = typeof proposals.$inferSelect;
export type ProposalInsert = typeof proposals.$inferInsert;

// MCP
export type McpServerConfig = typeof mcpServerConfigs.$inferSelect;
export type McpServerConfigInsert = typeof mcpServerConfigs.$inferInsert;
export type McpOauthState = typeof mcpOauthStates.$inferSelect;
export type McpOauthStateInsert = typeof mcpOauthStates.$inferInsert;

// Settings
export type Setting = typeof settings.$inferSelect;
export type SettingInsert = typeof settings.$inferInsert;

// Suggestions + command usage
export type Suggestion = typeof suggestions.$inferSelect;
export type SuggestionInsert = typeof suggestions.$inferInsert;
export type CommandUsage = typeof commandUsage.$inferSelect;
export type CommandUsageInsert = typeof commandUsage.$inferInsert;

// Sync
export type SyncCursor = typeof syncCursors.$inferSelect;
export type SyncCursorInsert = typeof syncCursors.$inferInsert;

// Audit + avatars + web-fetch
export type Audit = typeof audits.$inferSelect;
export type AuditInsert = typeof audits.$inferInsert;
export type Avatar = typeof avatars.$inferSelect;
export type AvatarInsert = typeof avatars.$inferInsert;
export type WebFetchEvent = typeof webFetchEvents.$inferSelect;
export type WebFetchEventInsert = typeof webFetchEvents.$inferInsert;
