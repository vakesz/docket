/**
 * Thin Drizzle wrappers for the conversations module.
 *
 * Lives separate from the router so the inbound-changes module
 * (`src/server/inbound-changes/inject.ts`) can reuse `appendMessage`
 * to inject synthetic system messages without going through tRPC.
 */

import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { ConversationId, ItemId, ProjectId, UserId } from "@/core/types";
import type { Db } from "@/db";
import { conversations, messages } from "@/db/schema";
import type { Conversation, Message } from "@/db/schema/types";

type ListArgs = {
  projectId: ProjectId;
  userId: UserId;
  itemId: ItemId | null;
  limit: number;
  archived: boolean;
};

export async function listConversations(db: Db, args: ListArgs): Promise<Conversation[]> {
  return db.query.conversations.findMany({
    where: and(
      eq(conversations.projectId, args.projectId),
      eq(conversations.userId, args.userId),
      ...(args.itemId !== null ? [eq(conversations.itemId, args.itemId)] : []),
      ...(args.archived ? [] : [isNull(conversations.archivedAt)]),
    ),
    orderBy: [desc(conversations.startedAt)],
    limit: args.limit,
  });
}

/**
 * Defense-in-depth cap on the live transcript size. The compaction service
 * (`src/server/conversations/compaction.ts`) is what *should* keep this
 * bounded by folding old messages into a synthetic summary; the cap here
 * protects the agent loop and UI from a runaway conversation that slipped
 * past compaction (long-running session, compaction not yet run, etc.).
 *
 * Read as "the most recent 500 non-compacted messages" — large enough that
 * normal use never trips it, small enough that loading is bounded.
 */
const LIVE_TRANSCRIPT_CAP = 500;

export async function getConversation(
  db: Db,
  conversationId: ConversationId,
): Promise<(Conversation & { messages: Message[] }) | null> {
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    with: {
      // Take the latest N then reverse to ascending — Drizzle can't express
      // "latest N ordered ascending" directly. The secondary `id` tiebreaker
      // keeps assistant + tool-result rows that share a microsecond
      // `createdAt` deterministically ordered (otherwise refetches shuffle
      // them in the chat UI).
      messages: {
        where: eq(messages.compacted, false),
        orderBy: [desc(messages.createdAt), desc(messages.id)],
        limit: LIVE_TRANSCRIPT_CAP,
      },
    },
  });
  if (!conv) return null;
  return { ...conv, messages: conv.messages.slice().reverse() };
}

export async function ownsConversation(
  db: Db,
  conversationId: ConversationId,
  projectId: ProjectId,
  userId: UserId,
): Promise<boolean> {
  const found = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.id, conversationId),
      eq(conversations.projectId, projectId),
      eq(conversations.userId, userId),
    ),
    columns: { id: true },
  });
  return found !== undefined;
}

/**
 * Owner-scoped fetch that returns the fields the SSE route needs in one
 * round-trip — ownership check + the per-conversation LLM override that
 * adapter resolution consumes. Returns `null` if the conversation doesn't
 * exist or the user/project pair doesn't own it.
 */
export async function getConversationForOwner(
  db: Db,
  conversationId: ConversationId,
  projectId: ProjectId,
  userId: UserId,
): Promise<{ id: ConversationId; llmProviderIdOverride: string | null } | null> {
  const row = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.id, conversationId),
      eq(conversations.projectId, projectId),
      eq(conversations.userId, userId),
    ),
    columns: { id: true, llmProviderIdOverride: true },
  });
  return row ?? null;
}

export async function createConversation(
  db: Db,
  args: { projectId: ProjectId; userId: UserId; itemId: ItemId | null },
): Promise<Conversation> {
  const [row] = await db
    .insert(conversations)
    .values({
      projectId: args.projectId,
      userId: args.userId,
      itemId: args.itemId,
    })
    .returning();
  if (!row) throw new Error("createConversation: insert returned no row");
  return row;
}

type AppendArgs = {
  conversationId: ConversationId;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * Tool-call records are stored as JSON; callers serialize their typed
   * shape (`LlmToolCall[]`) at the boundary.
   */
  toolCallsJson?: object | null;
  toolCallId?: string | null;
  toolName?: string | null;
  pending?: boolean;
};

export async function appendMessage(db: Db, args: AppendArgs): Promise<Message> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId: args.conversationId,
      role: args.role,
      content: args.content,
      toolCallsJson: args.toolCallsJson ?? null,
      toolCallId: args.toolCallId ?? null,
      toolName: args.toolName ?? null,
      pending: args.pending ?? false,
    })
    .returning();
  if (!row) throw new Error("appendMessage: insert returned no row");
  return row;
}

export async function archiveConversation(
  db: Db,
  conversationId: ConversationId,
): Promise<Conversation> {
  const [row] = await db
    .update(conversations)
    .set({ archivedAt: new Date() })
    .where(eq(conversations.id, conversationId))
    .returning();
  if (!row) throw new Error("archiveConversation: row not found");
  return row;
}

/**
 * Find every active (non-archived) conversation for a given item — the
 * inbound-changes module fans out to all of them when an external write
 * lands. Capped to bound the per-sync fan-out: a chatty item with hundreds
 * of open conversations would otherwise stamp a system message into every
 * one of them on each external write. The newest are returned first, so
 * the cap drops the long-stale conversations rather than the active ones.
 */
const ACTIVE_CONVERSATIONS_PER_ITEM_CAP = 50;

export async function activeConversationsForItem(
  db: Db,
  projectId: ProjectId,
  itemId: ItemId,
): Promise<Conversation[]> {
  return db.query.conversations.findMany({
    where: and(
      eq(conversations.projectId, projectId),
      eq(conversations.itemId, itemId),
      isNull(conversations.archivedAt),
    ),
    orderBy: [desc(conversations.startedAt)],
    limit: ACTIVE_CONVERSATIONS_PER_ITEM_CAP,
  });
}
