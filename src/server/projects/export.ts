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
 */

import "server-only";
import type { db as Db } from "@/server/db";

type Database = typeof Db;

export type ProjectExport = {
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
  };
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
};

export async function buildProjectExport(
  db: Database,
  projectId: string,
  userId: string,
): Promise<ProjectExport> {
  const [project, memory, sources, conversations] = await Promise.all([
    db.project.findUnique({
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
    }),
    db.memoryEntry.findMany({
      where: { projectId },
      orderBy: [{ updatedAt: "desc" }],
    }),
    db.sourceDoc.findMany({
      where: { projectId },
      orderBy: [{ updatedAt: "desc" }],
    }),
    db.conversation.findMany({
      where: { projectId, userId },
      orderBy: [{ startedAt: "desc" }],
      include: {
        messages: {
          orderBy: [{ createdAt: "asc" }],
        },
      },
    }),
  ]);

  if (!project) {
    throw new Error("project not found");
  }

  let messageCount = 0;
  const conversationsOut = conversations.map((c) => {
    messageCount += c.messages.length;
    return {
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
    };
  });

  return {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      providerKind: project.providerKind,
      providerScope: project.providerScope,
      defaultLlmProviderId: project.defaultLlmProviderId,
      defaultTemperature: project.defaultTemperature,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    },
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
  };
}
