// Compacted rows stay in the DB for audit but never replay to the LLM
// (the live transcript filters `compacted = false`). The synthesized
// summary appends as a fresh `role='system'` row with `compacted=false`
// so the next prompt picks it up. Lives outside the byte-stable prefix
// in `src/agent/prompt.ts` — adding to that prefix would break the cache.

import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { ConversationId, ProjectId } from "@/core/types";
import type { Db } from "@/db";
import { messages } from "@/db/schema";
import type { Message } from "@/db/schema/types";
import { loadProjectSetting } from "@/server/settings/effective";

export type CompactionSettings = {
  enabled: boolean;
  tokenThreshold: number;
  keepRecentTurns: number;
  strategy: "summary" | "drop-tools";
};

export async function loadCompactionSettings(
  db: Db,
  projectId: ProjectId,
): Promise<CompactionSettings> {
  const [enabled, tokenThreshold, keepRecentTurns, strategy] = await Promise.all([
    loadProjectSetting(db, projectId, "llm.compaction.enabled"),
    loadProjectSetting(db, projectId, "llm.compaction.token-threshold"),
    loadProjectSetting(db, projectId, "llm.compaction.keep-recent-turns"),
    loadProjectSetting(db, projectId, "llm.compaction.strategy"),
  ]);
  return { enabled, tokenThreshold, keepRecentTurns, strategy };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function estimateTranscriptTokens(transcript: readonly Message[]): number {
  let total = 0;
  for (const m of transcript) {
    total += estimateTokens(m.content);
    if (m.toolCallsJson) total += estimateTokens(JSON.stringify(m.toolCallsJson));
  }
  return total;
}

export type CompactionDecision = {
  shouldCompact: boolean;
  estimatedTokens: number;
  utilization: number;
};

export function evaluate(
  transcript: readonly Message[],
  settings: CompactionSettings,
): CompactionDecision {
  const estimatedTokens = estimateTranscriptTokens(transcript);
  const utilization = settings.tokenThreshold > 0 ? estimatedTokens / settings.tokenThreshold : 0;
  return {
    shouldCompact: settings.enabled && estimatedTokens >= settings.tokenThreshold,
    estimatedTokens,
    utilization,
  };
}

export type CompactionResult = {
  ok: boolean;
  reason?: string;
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
};

export async function compactConversation(
  db: Db,
  conversationId: ConversationId,
  settings: CompactionSettings,
): Promise<CompactionResult> {
  const transcript = await db.query.messages.findMany({
    where: and(eq(messages.conversationId, conversationId), eq(messages.compacted, false)),
    orderBy: [asc(messages.createdAt)],
  });
  const tokensBefore = estimateTranscriptTokens(transcript);
  if (tokensBefore < settings.tokenThreshold) {
    return {
      ok: true,
      reason: "below threshold",
      compactedCount: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  const keep = Math.max(2, settings.keepRecentTurns);
  if (transcript.length <= keep) {
    return {
      ok: false,
      reason: "transcript shorter than keep-recent-turns; nothing to compact",
      compactedCount: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  const cutoff = transcript.length - keep;
  const older = transcript.slice(0, cutoff);
  const recent = transcript.slice(cutoff);

  if (settings.strategy === "drop-tools") {
    const dropIds = older
      .filter((m) => m.role === "tool" || (m.role === "assistant" && m.toolCallsJson != null))
      .map((m) => m.id);
    if (dropIds.length === 0) {
      return {
        ok: false,
        reason: "no tool-call/result rows in older slice; nothing to drop",
        compactedCount: 0,
        tokensBefore,
        tokensAfter: tokensBefore,
      };
    }
    await db.update(messages).set({ compacted: true }).where(inArray(messages.id, dropIds));
    const tokensAfter = estimateTranscriptTokens([
      ...older.filter((m) => !dropIds.includes(m.id)),
      ...recent,
    ]);
    return { ok: true, compactedCount: dropIds.length, tokensBefore, tokensAfter };
  }

  const summary = buildHeuristicSummary(older);
  const olderIds = older.map((m) => m.id);
  await db.transaction(async (tx) => {
    await tx.insert(messages).values({
      conversationId,
      role: "system",
      content: summary,
      compacted: false,
    });
    await tx.update(messages).set({ compacted: true }).where(inArray(messages.id, olderIds));
  });
  const tokensAfter = estimateTokens(summary) + estimateTranscriptTokens(recent);
  return { ok: true, compactedCount: older.length, tokensBefore, tokensAfter };
}

function buildHeuristicSummary(transcript: readonly Message[]): string {
  const lines: string[] = [
    `[Compaction summary — ${transcript.length} earlier turn${transcript.length === 1 ? "" : "s"} folded]`,
  ];
  const userTurns = transcript.filter((m) => m.role === "user").length;
  const assistantTurns = transcript.filter((m) => m.role === "assistant").length;
  const toolTurns = transcript.filter((m) => m.role === "tool").length;
  lines.push(
    `Roles: ${userTurns} user, ${assistantTurns} assistant, ${toolTurns} tool result${toolTurns === 1 ? "" : "s"}.`,
  );
  const userHighlights = transcript
    .filter((m) => m.role === "user")
    .slice(-5)
    .map((m) => `- user: ${firstLine(m.content)}`);
  if (userHighlights.length > 0) {
    lines.push("Recent user asks (oldest first):");
    lines.push(...userHighlights);
  }
  const assistantTail = transcript
    .filter((m) => m.role === "assistant" && m.content.trim().length > 0)
    .slice(-1)
    .map((m) => `- assistant (last before fold): ${firstLine(m.content)}`);
  lines.push(...assistantTail);
  lines.push("(Detailed history archived; reply will resume from the most recent turns.)");
  return lines.join("\n");
}

function firstLine(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "(empty)";
  const nl = trimmed.indexOf("\n");
  const oneLine = nl === -1 ? trimmed : trimmed.slice(0, nl);
  return oneLine.length > 240 ? `${oneLine.slice(0, 237)}…` : oneLine;
}
