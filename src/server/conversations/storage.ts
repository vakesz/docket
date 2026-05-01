/**
 * Thin Prisma wrappers for the conversations module.
 *
 * Lives separate from the router so the inbound-changes module
 * (`src/server/inbound-changes/inject.ts`) can reuse `appendMessage`
 * to inject synthetic system messages without going through tRPC.
 */

import "server-only";
import type { Conversation, Message } from "@/db/generated/client";
import type { db as Db } from "@/server/db";

type Database = typeof Db;

type ListArgs = {
  projectId: string;
  userId: string;
  itemId: string | null;
  limit: number;
  archived: boolean;
};

export async function listConversations(db: Database, args: ListArgs): Promise<Conversation[]> {
  return db.conversation.findMany({
    where: {
      projectId: args.projectId,
      userId: args.userId,
      ...(args.itemId !== null ? { itemId: args.itemId } : {}),
      ...(args.archived ? {} : { archivedAt: null }),
    },
    orderBy: [{ startedAt: "desc" }],
    take: args.limit,
  });
}

export async function getConversation(
  db: Database,
  conversationId: string,
): Promise<(Conversation & { messages: Message[] }) | null> {
  return db.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: {
        where: { compacted: false },
        // Secondary `id` tiebreaker: assistant + tool-result rows are
        // written back-to-back during a turn and can collide on
        // microsecond `createdAt`. Without a tiebreaker the display order
        // becomes nondeterministic across refetches — visible as messages
        // shuffling around in the chat after the stream completes.
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
}

export async function ownsConversation(
  db: Database,
  conversationId: string,
  projectId: string,
  userId: string,
): Promise<boolean> {
  const found = await db.conversation.findFirst({
    where: { id: conversationId, projectId, userId },
    select: { id: true },
  });
  return found !== null;
}

export async function createConversation(
  db: Database,
  args: { projectId: string; userId: string; itemId: string | null },
): Promise<Conversation> {
  return db.conversation.create({
    data: {
      projectId: args.projectId,
      userId: args.userId,
      itemId: args.itemId,
    },
  });
}

type AppendArgs = {
  conversationId: string;
  /** 'system' | 'user' | 'assistant' | 'tool' */
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallsJson?: object | null;
  toolCallId?: string | null;
  toolName?: string | null;
  pending?: boolean;
};

export async function appendMessage(db: Database, args: AppendArgs): Promise<Message> {
  const toolCallsJson = args.toolCallsJson ?? undefined;
  return db.message.create({
    data: {
      conversationId: args.conversationId,
      role: args.role,
      content: args.content,
      ...(toolCallsJson !== undefined ? { toolCallsJson } : {}),
      toolCallId: args.toolCallId ?? null,
      toolName: args.toolName ?? null,
      pending: args.pending ?? false,
    },
  });
}

export async function archiveConversation(
  db: Database,
  conversationId: string,
): Promise<Conversation> {
  return db.conversation.update({
    where: { id: conversationId },
    data: { archivedAt: new Date() },
  });
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
  db: Database,
  projectId: string,
  itemId: string,
): Promise<Conversation[]> {
  return db.conversation.findMany({
    where: { projectId, itemId, archivedAt: null },
    orderBy: [{ startedAt: "desc" }],
    take: ACTIVE_CONVERSATIONS_PER_ITEM_CAP,
  });
}
