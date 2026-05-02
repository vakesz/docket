// Compacted rows stay in the DB for audit but never replay to the LLM
// (the live transcript filters `compacted = false`). The synthesized
// summary appends as a fresh `role='system'` row with `compacted=false`
// so the next prompt picks it up. Lives outside the byte-stable prefix
// in `src/agent/prompt.ts` — adding to that prefix would break the cache.

import "server-only";
import type { Message } from "@/db/generated/client";
import type { db as Db } from "@/server/db";
import { loadProjectSetting } from "@/server/settings/effective";

type Database = typeof Db;

export type CompactionSettings = {
  enabled: boolean;
  tokenThreshold: number;
  keepRecentTurns: number;
  strategy: "summary" | "drop-tools";
};

export async function loadCompactionSettings(
  db: Database,
  projectId: string,
): Promise<CompactionSettings> {
  const [enabled, tokenThreshold, keepRecentTurns, strategy] = await Promise.all([
    loadProjectSetting(db, projectId, "llm.compaction.enabled"),
    loadProjectSetting(db, projectId, "llm.compaction.token-threshold"),
    loadProjectSetting(db, projectId, "llm.compaction.keep-recent-turns"),
    loadProjectSetting(db, projectId, "llm.compaction.strategy"),
  ]);
  return { enabled, tokenThreshold, keepRecentTurns, strategy };
}

/**
 * Rough char-based token estimate. Avoids pulling in tiktoken/gpt-tokenizer
 * — the threshold is a guide rail, not an accountancy figure. Empirically
 * 4 chars ≈ 1 token for English; we use 3.5 to bias slightly conservative
 * so compaction triggers a touch earlier than the model's hard limit.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function estimateTranscriptTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content);
    if (m.toolCallsJson) total += estimateTokens(JSON.stringify(m.toolCallsJson));
  }
  return total;
}

export type CompactionDecision = {
  shouldCompact: boolean;
  estimatedTokens: number;
  /** Fraction of the threshold currently used (0 → empty, 1 → at threshold). */
  utilization: number;
};

export function evaluate(
  messages: readonly Message[],
  settings: CompactionSettings,
): CompactionDecision {
  const estimatedTokens = estimateTranscriptTokens(messages);
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
  /** Messages folded into the summary (or dropped). */
  compactedCount: number;
  /** Tokens before / after, by the same heuristic used to gate the decision. */
  tokensBefore: number;
  tokensAfter: number;
};

/**
 * Run a compaction pass. Idempotent: if the transcript is already under
 * the threshold the call is a no-op. Always called from outside the
 * streaming loop — never mid-turn — so we don't have to worry about
 * tearing down a partially-persisted assistant turn.
 *
 * The summary strategy currently uses a deterministic heuristic summary
 * rather than a separate LLM call. That keeps the implementation
 * dependency-free and predictable; an LLM-based summary can replace
 * `buildHeuristicSummary` later without touching callers.
 */
export async function compactConversation(
  db: Database,
  conversationId: string,
  settings: CompactionSettings,
): Promise<CompactionResult> {
  const messages = await db.message.findMany({
    where: { conversationId, compacted: false },
    orderBy: { createdAt: "asc" },
  });
  const tokensBefore = estimateTranscriptTokens(messages);
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
  if (messages.length <= keep) {
    return {
      ok: false,
      reason: "transcript shorter than keep-recent-turns; nothing to compact",
      compactedCount: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  const cutoff = messages.length - keep;
  const older = messages.slice(0, cutoff);
  const recent = messages.slice(cutoff);

  if (settings.strategy === "drop-tools") {
    // Mark only assistant-tool-call rows and their tool-result rows in the
    // older slice. Keep prose-only turns (they're tiny and useful context).
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
    await db.message.updateMany({
      where: { id: { in: dropIds } },
      data: { compacted: true },
    });
    const tokensAfter = estimateTranscriptTokens([
      ...older.filter((m) => !dropIds.includes(m.id)),
      ...recent,
    ]);
    return { ok: true, compactedCount: dropIds.length, tokensBefore, tokensAfter };
  }

  // Strategy: "summary". Replace the older slice with one synthetic system
  // message and mark each folded row `compacted = true`.
  const summary = buildHeuristicSummary(older);
  await db.$transaction([
    db.message.create({
      data: {
        conversationId,
        role: "system",
        content: summary,
        compacted: false,
      },
    }),
    db.message.updateMany({
      where: { id: { in: older.map((m) => m.id) } },
      data: { compacted: true },
    }),
  ]);
  const tokensAfter = estimateTokens(summary) + estimateTranscriptTokens(recent);
  return { ok: true, compactedCount: older.length, tokensBefore, tokensAfter };
}

/**
 * Heuristic summary: an enumerated list of "role: first-line" entries plus
 * the count of folded turns. Cheap, deterministic, and good enough until a
 * real summarizer ships.
 */
function buildHeuristicSummary(messages: readonly Message[]): string {
  const lines: string[] = [
    `[Compaction summary — ${messages.length} earlier turn${messages.length === 1 ? "" : "s"} folded]`,
  ];
  const userTurns = messages.filter((m) => m.role === "user").length;
  const assistantTurns = messages.filter((m) => m.role === "assistant").length;
  const toolTurns = messages.filter((m) => m.role === "tool").length;
  lines.push(
    `Roles: ${userTurns} user, ${assistantTurns} assistant, ${toolTurns} tool result${toolTurns === 1 ? "" : "s"}.`,
  );
  const userHighlights = messages
    .filter((m) => m.role === "user")
    .slice(-5)
    .map((m) => `- user: ${firstLine(m.content)}`);
  if (userHighlights.length > 0) {
    lines.push("Recent user asks (oldest first):");
    lines.push(...userHighlights);
  }
  const assistantTail = messages
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
