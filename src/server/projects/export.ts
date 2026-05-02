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
import type { db as Db } from "@/server/db";

type Database = typeof Db;

const EXPORT_CONVERSATIONS_PER_PAGE = 200;
const EXPORT_MESSAGES_PER_PAGE = 10_000;
const EXPORT_MESSAGES_PER_CONVERSATION = 5_000;

export type ProjectExportCursor = {
  startedAt: string;
  conversationId: string;
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
  db: Database,
  projectId: string,
  userId: string,
  cursor: ProjectExportCursor | null = null,
): Promise<ProjectExportPage> {
  const isFirstPage = cursor === null;

  const conversationWhere = cursor
    ? {
        projectId,
        userId,
        OR: [
          { startedAt: { lt: new Date(cursor.startedAt) } },
          {
            AND: [{ startedAt: new Date(cursor.startedAt) }, { id: { lt: cursor.conversationId } }],
          },
        ],
      }
    : { projectId, userId };

  const [project, memory, sources, conversations] = await Promise.all([
    isFirstPage
      ? db.project.findUnique({
          where: { id: projectId },
          select: {
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
      : Promise.resolve(null),
    isFirstPage
      ? db.memoryEntry.findMany({
          where: { projectId },
          orderBy: [{ updatedAt: "desc" }],
        })
      : Promise.resolve([]),
    isFirstPage
      ? db.sourceDoc.findMany({
          where: { projectId },
          orderBy: [{ updatedAt: "desc" }],
        })
      : Promise.resolve([]),
    db.conversation.findMany({
      where: conversationWhere,
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: EXPORT_CONVERSATIONS_PER_PAGE,
      include: {
        messages: {
          orderBy: [{ createdAt: "asc" }],
          take: EXPORT_MESSAGES_PER_CONVERSATION,
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

  for (const c of conversations) {
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

  // Filled the page batch — assume there might be more, hand back a cursor
  // pointing past the last conversation we emitted.
  if (
    nextCursor === null &&
    conversations.length === EXPORT_CONVERSATIONS_PER_PAGE &&
    conversationsOut.length === conversations.length
  ) {
    const last = conversations[conversations.length - 1];
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
      tags: m.tags,
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
      tags: s.tags,
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
