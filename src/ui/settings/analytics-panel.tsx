"use client";

import { useId, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { BarChart } from "@/ui/settings/analytics/bar-chart";
import { DataTable } from "@/ui/settings/analytics/data-table";
import { TotalsStrip } from "@/ui/settings/analytics/totals-strip";
import { TrendChart } from "@/ui/settings/analytics/trend-chart";

const PRESETS: { days: number; label: string }[] = [
  { days: 7, label: "7d" },
  { days: 14, label: "14d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
];

/**
 * LLM usage chart. Same component for project and global scopes — the
 * `scope` prop picks which router endpoint to query. Renders a barchart
 * with one bar per UTC day stacked tokens-in below, tokens-out above,
 * plus a totals strip and an axis on the right with the spend.
 *
 * Pure CSS bars: avoids pulling in a chart library for what's still a
 * single visualisation, and the tokens fit better with the existing
 * theme tokens than any third-party defaults would.
 *
 * Sub-components live in `./analytics/` — split out to keep this file a
 * thin orchestrator. See `bar-chart.tsx`, `trend-chart.tsx`,
 * `totals-strip.tsx`, `data-table.tsx`.
 */
export function AnalyticsPanel(
  props: { scope: "global" } | { scope: "project"; projectSlug: string },
) {
  const [days, setDays] = useState(14);
  const customDaysId = useId();

  const projectQuery = trpc.analytics.projectDaily.useQuery(
    {
      projectSlug: props.scope === "project" ? props.projectSlug : "",
      days,
    },
    { enabled: props.scope === "project" },
  );
  const globalQuery = trpc.analytics.globalDaily.useQuery(
    { days },
    { enabled: props.scope === "global" },
  );

  const data = props.scope === "project" ? projectQuery.data : globalQuery.data;
  const isPending = props.scope === "project" ? projectQuery.isPending : globalQuery.isPending;
  const error = props.scope === "project" ? projectQuery.error : globalQuery.error;

  const peakCost = (() => {
    if (!data) return 0;
    let p = 0;
    for (const b of data.buckets) {
      const total = b.costCents + b.guardrailCostCents;
      if (total > p) p = total;
    }
    return p;
  })();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs">Window:</span>
        {PRESETS.map((p) => (
          <button
            key={p.days}
            type="button"
            onClick={() => setDays(p.days)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs",
              days === p.days
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-foreground hover:bg-muted",
            )}
          >
            {p.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor={customDaysId} className="text-muted-foreground text-xs">
            Custom (days):
          </Label>
          <Input
            id={customDaysId}
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            step={1}
            value={days}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              if (!Number.isFinite(next)) return;
              setDays(Math.max(1, Math.min(365, next)));
            }}
            className="w-20"
          />
        </div>
      </div>

      {isPending ? <p className="text-muted-foreground/70 text-sm">Loading…</p> : null}
      {error ? <p className="text-destructive text-xs">{error.message}</p> : null}

      {data ? (
        <>
          <TotalsStrip data={data} />
          <TrendChart buckets={data.buckets} />
          <BarChart buckets={data.buckets} peakCost={peakCost} />
          <DataTable buckets={data.buckets} />
        </>
      ) : null}
    </div>
  );
}
