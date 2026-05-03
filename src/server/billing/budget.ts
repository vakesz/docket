/**
 * Monthly LLM budget guard.
 *
 * Backed by `conversations.costCents` + `conversations.guardrailCostCents`
 * rows the agent loop already increments after each streaming turn. Both
 * columns bill against the operator's API key, so both count toward the
 * cap. Cap + action come from global Settings:
 * `llm.monthly-cost-cap-cents` and `llm.cost-cap-action`.
 *
 * The cap is calendar-month based in UTC so a deployment-wide cap rolls
 * over predictably regardless of the operator's local time zone.
 */

import "server-only";
import { gte, sum } from "drizzle-orm";
import type { Db } from "@/db";
import { conversations } from "@/db/schema";
import { loadGlobalSetting } from "@/server/settings/effective";

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

// `sum()` over an integer column comes back as `numeric` from postgres-js,
// which surfaces as a decimal string. Bad/missing rows fall back to 0
// instead of poisoning the total with NaN.
function toCents(raw: string | null | undefined): number {
  if (raw == null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function getBudgetStatus(db: Db): Promise<BudgetStatus> {
  const [capCents, action] = await Promise.all([
    loadGlobalSetting(db, "llm.monthly-cost-cap-cents"),
    loadGlobalSetting(db, "llm.cost-cap-action"),
  ]);
  const since = startOfMonthUtc();
  // postgres-js returns SUM() over an integer column as a numeric string;
  // coerce + clamp to a safe integer at the boundary.
  const [agg] = await db
    .select({
      chat: sum(conversations.costCents),
      guardrail: sum(conversations.guardrailCostCents),
    })
    .from(conversations)
    .where(gte(conversations.startedAt, since));
  const monthCents = toCents(agg?.chat) + toCents(agg?.guardrail);
  const capReached = capCents > 0 && monthCents >= capCents;
  const remainingCents = capCents > 0 ? Math.max(0, capCents - monthCents) : 0;
  return { monthCents, capCents, remainingCents, capReached, action };
}
