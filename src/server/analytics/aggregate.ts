/**
 * LLM usage analytics aggregator.
 *
 * Source of truth: `Conversation.tokensIn / tokensOut / costCents`. Each
 * `runTurn()` increments those columns post-stream, and the row's
 * `startedAt` is the time bucket — close enough to "when the spend
 * happened" for daily charts and avoids touching `Message` rows.
 *
 * Two aggregation surfaces:
 *   - `aggregateProjectDaily(projectId, days)` — single project, day buckets
 *   - `aggregateGlobalDaily(days)` — every project the current viewer can see
 *
 * Buckets are calendar days in UTC, returned as the array `[{ date,
 * tokensIn, tokensOut, costCents, conversations }]` ordered oldest →
 * newest. The chart pane fills in zeros for missing days client-side.
 */

import "server-only";
import { and, eq, gte } from "drizzle-orm";
import type { ProjectId } from "@/core/types";
import type { Db } from "@/db";
import { conversations } from "@/db/schema";

export type DailyBucket = {
  /** YYYY-MM-DD (UTC). */
  date: string;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  /** Guardrail-side spend, broken out so the chart can stack it. */
  guardrailTokensIn: number;
  guardrailTokensOut: number;
  guardrailCostCents: number;
  conversations: number;
};

export type AggregateResult = {
  /** Oldest → newest, gaps zero-filled across the requested window. */
  buckets: DailyBucket[];
  /** Sum across the window (matches the bars). */
  totals: {
    tokensIn: number;
    tokensOut: number;
    costCents: number;
    guardrailTokensIn: number;
    guardrailTokensOut: number;
    guardrailCostCents: number;
    conversations: number;
  };
  /** Inclusive UTC start (YYYY-MM-DD) of the window. */
  from: string;
  /** Inclusive UTC end (YYYY-MM-DD) of the window. */
  to: string;
};

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function isoDay(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + n);
  return next;
}

function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 14;
  return Math.max(1, Math.min(365, Math.floor(days)));
}

async function aggregate(
  db: Db,
  scope: { projectId?: ProjectId },
  days: number,
): Promise<AggregateResult> {
  const window = clampDays(days);
  const todayStart = startOfUtcDay(new Date());
  const fromStart = addDays(todayStart, -(window - 1));

  const rows = await db.query.conversations.findMany({
    where: and(
      gte(conversations.startedAt, fromStart),
      ...(scope.projectId ? [eq(conversations.projectId, scope.projectId)] : []),
    ),
    columns: {
      id: true,
      startedAt: true,
      tokensIn: true,
      tokensOut: true,
      costCents: true,
      guardrailTokensIn: true,
      guardrailTokensOut: true,
      guardrailCostCents: true,
    },
  });

  const byDay = new Map<string, DailyBucket>();
  for (let i = 0; i < window; i++) {
    const d = addDays(fromStart, i);
    const key = isoDay(d);
    byDay.set(key, {
      date: key,
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
      guardrailTokensIn: 0,
      guardrailTokensOut: 0,
      guardrailCostCents: 0,
      conversations: 0,
    });
  }

  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  let totalGuardIn = 0;
  let totalGuardOut = 0;
  let totalGuardCost = 0;
  let totalConv = 0;
  for (const row of rows) {
    const key = isoDay(startOfUtcDay(row.startedAt));
    const bucket = byDay.get(key);
    if (!bucket) continue;
    bucket.tokensIn += row.tokensIn;
    bucket.tokensOut += row.tokensOut;
    bucket.costCents += row.costCents;
    bucket.guardrailTokensIn += row.guardrailTokensIn;
    bucket.guardrailTokensOut += row.guardrailTokensOut;
    bucket.guardrailCostCents += row.guardrailCostCents;
    bucket.conversations += 1;
    totalIn += row.tokensIn;
    totalOut += row.tokensOut;
    totalCost += row.costCents;
    totalGuardIn += row.guardrailTokensIn;
    totalGuardOut += row.guardrailTokensOut;
    totalGuardCost += row.guardrailCostCents;
    totalConv += 1;
  }

  return {
    buckets: Array.from(byDay.values()),
    totals: {
      tokensIn: totalIn,
      tokensOut: totalOut,
      costCents: totalCost,
      guardrailTokensIn: totalGuardIn,
      guardrailTokensOut: totalGuardOut,
      guardrailCostCents: totalGuardCost,
      conversations: totalConv,
    },
    from: isoDay(fromStart),
    to: isoDay(todayStart),
  };
}

export function aggregateProjectDaily(
  db: Db,
  projectId: ProjectId,
  days: number,
): Promise<AggregateResult> {
  return aggregate(db, { projectId }, days);
}

export function aggregateGlobalDaily(db: Db, days: number): Promise<AggregateResult> {
  return aggregate(db, {}, days);
}
