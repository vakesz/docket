/**
 * Project data export.
 *
 * Bundles a project's durable knowledge (memory + sources) and the
 * caller's conversation history (with messages, including compacted
 * rows so the export is a faithful archive) into a single JSON
 * payload suitable for download.
 *
 * Read-only — runs through `projectScopedProcedure`. The conversations
 * filter by `userId` so a member exporting only sees their own chats;
 * memory + sources are project-wide and visible to every member.
 *
 * Paginated. The first page (cursor === null) carries project + memory +
 * sources + the newest conversations up to a per-page message budget;
 * later pages omit the meta and continue with older conversations. The
 * client loops on `nextCursor` and merges into one download.
 */

import "server-only";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { ConversationId, ProjectId, UserId } from "@/core/types";
import type { Db } from "@/db";
import { conversations, memoryEntries, projects, sourceDocs } from "@/db/schema";

const EXPORT_CONVERSATIONS_PER_PAGE = 200;
const EXPORT_MESSAGES_PER_PAGE = 10_000;
const EXPORT_MESSAGES_PER_CONVERSATION = 5_000;

export type ProjectExportCursor = {
  startedAt: string;
  conversationId: ConversationId;
};

export type ProjectExportPage = {
  formatVersion: 1;
  generatedAt: string;
  project: {
    id: string;
    name: string;
    description: string;
    providerKind: string;
    providerScope: unknown;
    defaultLlmProviderId: string | null;
    defaultTemperature: number | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  memory: Array<{
    id: string;
    title: string;
    body: string;
    tags: string[];
    source: string;
    createdAt: string;
    updatedAt: string;
  }>;
  sources: Array<{
    id: string;
    title: string;
    kind: string;
    uri: string;
    body: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
  }>;
  conversations: Array<{
    id: string;
    itemId: string | null;
    startedAt: string;
    archivedAt: string | null;
    tokensIn: number;
    tokensOut: number;
    costCents: number;
    messages: Array<{
      id: string;
      role: string;
      content: string;
      toolCallsJson: unknown;
      toolCallId: string | null;
      toolName: string | null;
      compacted: boolean;
      tokensIn: number;
      tokensOut: number;
      createdAt: string;
    }>;
  }>;
  counts: {
    memory: number;
    sources: number;
    conversations: number;
    messages: number;
  };
  nextCursor: ProjectExportCursor | null;
};

export async function buildProjectExport(
  db: Db,
  projectId: ProjectId,
  userId: UserId,
  cursor: ProjectExportCursor | null = null,
): Promise<ProjectExportPage> {
  const isFirstPage = cursor === null;

  // Composite cursor: order by (startedAt DESC, id DESC) means the next page
  // is "row whose startedAt is strictly less, OR same-startedAt but lower id".
  const cursorWhere = cursor
    ? or(
        lt(conversations.startedAt, new Date(cursor.startedAt)),
        and(
          eq(conversations.startedAt, new Date(cursor.startedAt)),
          lt(conversations.id, cursor.conversationId),
        ),
      )
    : undefined;

  const baseConvWhere = and(
    eq(conversations.projectId, projectId),
    eq(conversations.userId, userId),
    ...(cursorWhere ? [cursorWhere] : []),
  );

  const [project, memory, sources, conversationRows] = await Promise.all([
    isFirstPage
      ? db.query.projects.findFirst({
          where: eq(projects.id, projectId),
          columns: {
            id: true,
            name: true,
            description: true,
            providerKind: true,
            providerScope: true,
            defaultLlmProviderId: true,
            defaultTemperature: true,
            createdAt: true,
            updatedAt: true,
          },
        })
      : Promise.resolve(undefined),
    isFirstPage
      ? db.query.memoryEntries.findMany({
          where: eq(memoryEntries.projectId, projectId),
          orderBy: [desc(memoryEntries.updatedAt)],
        })
      : Promise.resolve([]),
    isFirstPage
      ? db.query.sourceDocs.findMany({
          where: eq(sourceDocs.projectId, projectId),
          orderBy: [desc(sourceDocs.updatedAt)],
        })
      : Promise.resolve([]),
    db.query.conversations.findMany({
      where: baseConvWhere,
      orderBy: [desc(conversations.startedAt), desc(conversations.id)],
      limit: EXPORT_CONVERSATIONS_PER_PAGE,
      with: {
        messages: {
          orderBy: (msg, { asc: ascOrd }) => [ascOrd(msg.createdAt)],
          limit: EXPORT_MESSAGES_PER_CONVERSATION,
        },
      },
    }),
  ]);

  if (isFirstPage && !project) {
    throw new Error("project not found");
  }

  // Walk newest-first; once total messages exceed the budget, stop and
  // emit a cursor at the next conversation. Always include at least one
  // conversation per page so a single oversized thread can't deadlock.
  let messageCount = 0;
  let nextCursor: ProjectExportCursor | null = null;
  const conversationsOut: ProjectExportPage["conversations"] = [];

  for (const c of conversationRows) {
    if (
      conversationsOut.length > 0 &&
      messageCount + c.messages.length > EXPORT_MESSAGES_PER_PAGE
    ) {
      nextCursor = { startedAt: c.startedAt.toISOString(), conversationId: c.id };
      break;
    }
    messageCount += c.messages.length;
    conversationsOut.push({
      id: c.id,
      itemId: c.itemId,
      startedAt: c.startedAt.toISOString(),
      archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null,
      tokensIn: c.tokensIn,
      tokensOut: c.tokensOut,
      costCents: c.costCents,
      messages: c.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolCallsJson: m.toolCallsJson,
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        compacted: m.compacted,
        tokensIn: m.tokensIn,
        tokensOut: m.tokensOut,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  }

  if (
    nextCursor === null &&
    conversationRows.length === EXPORT_CONVERSATIONS_PER_PAGE &&
    conversationsOut.length === conversationRows.length
  ) {
    const last = conversationRows[conversationRows.length - 1];
    if (last) {
      nextCursor = { startedAt: last.startedAt.toISOString(), conversationId: last.id };
    }
  }

  return {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    project: project
      ? {
          id: project.id,
          name: project.name,
          description: project.description,
          providerKind: project.providerKind,
          providerScope: project.providerScope,
          defaultLlmProviderId: project.defaultLlmProviderId,
          defaultTemperature: project.defaultTemperature,
          createdAt: project.createdAt.toISOString(),
          updatedAt: project.updatedAt.toISOString(),
        }
      : null,
    memory: memory.map((m) => ({
      id: m.id,
      title: m.title,
      body: m.body,
      tags: [...m.tags],
      source: m.source,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    })),
    sources: sources.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      uri: s.uri,
      body: s.body,
      tags: [...s.tags],
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    })),
    conversations: conversationsOut,
    counts: {
      memory: memory.length,
      sources: sources.length,
      conversations: conversationsOut.length,
      messages: messageCount,
    },
    nextCursor,
  };
}
