/**
 * Monthly LLM budget guard.
 *
 * Backed by `Conversation.costCents` rows the agent loop already increments
 * after each streaming turn. Cap + action come from global Settings:
 * `llm.monthly-cost-cap-cents` and `llm.cost-cap-action`.
 *
 * The cap is calendar-month based in UTC so a deployment-wide cap rolls
 * over predictably regardless of the operator's local time zone.
 */

import "server-only";
import type { db as Db } from "@/server/db";
import { loadGlobalSetting } from "@/server/settings/effective";

type Database = typeof Db;

export type BudgetStatus = {
  /** Cents accrued in the current calendar month (UTC). */
  monthCents: number;
  /** Cap from settings; 0 means no cap configured. */
  capCents: number;
  /** When `capCents > 0`, cents remaining before the cap (clamped at zero). */
  remainingCents: number;
  /** True iff cap is configured AND month spend ≥ cap. */
  capReached: boolean;
  /** What to do at the cap: 'warn' (allow + banner) or 'block' (refuse). */
  action: "warn" | "block";
};

function startOfMonthUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

export async function getBudgetStatus(db: Database): Promise<BudgetStatus> {
  const [capCents, action] = await Promise.all([
    loadGlobalSetting(db, "llm.monthly-cost-cap-cents"),
    loadGlobalSetting(db, "llm.cost-cap-action"),
  ]);
  const since = startOfMonthUtc();
  const agg = await db.conversation.aggregate({
    where: { startedAt: { gte: since } },
    _sum: { costCents: true },
  });
  const monthCents = agg._sum.costCents ?? 0;
  const capReached = capCents > 0 && monthCents >= capCents;
  const remainingCents = capCents > 0 ? Math.max(0, capCents - monthCents) : 0;
  return { monthCents, capCents, remainingCents, capReached, action };
}
