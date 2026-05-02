"use client";

import { LegendDot } from "@/ui/settings/analytics/legend-dot";
import type { Bucket } from "@/ui/settings/analytics/types";

export function BarChart({ buckets, peakCost }: { buckets: Bucket[]; peakCost: number }) {
  if (buckets.length === 0) return null;
  const peak = peakCost > 0 ? peakCost : 1;
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <h4 className="font-medium text-foreground text-sm">Daily spend</h4>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground uppercase tracking-wide">
          <LegendDot color="bg-primary/70" label="Chat" />
          <LegendDot color="bg-chart-1/80" label="Guardrail" />
          <span>peak ${(peak / 100).toFixed(2)}</span>
        </div>
      </div>
      <div className="flex h-40 items-end gap-1">
        {buckets.map((b) => {
          const total = b.costCents + b.guardrailCostCents;
          const pct = peak > 0 ? (total / peak) * 100 : 0;
          const chatShare = total > 0 ? (b.costCents / total) * pct : 0;
          const guardShare = total > 0 ? (b.guardrailCostCents / total) * pct : 0;
          return (
            <div
              key={b.date}
              className="group relative flex flex-1 flex-col items-end justify-end"
              title={`${b.date}: chat $${(b.costCents / 100).toFixed(3)} · guardrail $${(b.guardrailCostCents / 100).toFixed(3)} · ${b.conversations} conv`}
            >
              <div
                className="w-full bg-chart-1/80 transition-colors group-hover:bg-chart-1"
                style={{ height: `${guardShare}%` }}
              />
              <div
                className="w-full rounded-t bg-primary/70 transition-colors group-hover:bg-primary"
                style={{ height: `${Math.max(chatShare, total > 0 && b.costCents > 0 ? 2 : 0)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-muted-foreground/70">
        <span>{buckets[0]?.date}</span>
        <span>{buckets[buckets.length - 1]?.date}</span>
      </div>
    </div>
  );
}
