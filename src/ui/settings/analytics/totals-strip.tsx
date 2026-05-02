"use client";

import type { DailyTotals } from "@/ui/settings/analytics/types";

export function TotalsStrip({
  data,
}: {
  data: {
    totals: DailyTotals;
    from: string;
    to: string;
  };
}) {
  const totalSpend = data.totals.costCents + data.totals.guardrailCostCents;
  const stats = [
    { label: "Conversations", value: data.totals.conversations.toLocaleString() },
    {
      label: "Tokens in",
      value: (data.totals.tokensIn + data.totals.guardrailTokensIn).toLocaleString(),
      sub: `${data.totals.guardrailTokensIn.toLocaleString()} guardrail`,
    },
    {
      label: "Tokens out",
      value: (data.totals.tokensOut + data.totals.guardrailTokensOut).toLocaleString(),
      sub: `${data.totals.guardrailTokensOut.toLocaleString()} guardrail`,
    },
    {
      label: "Spend",
      value: `$${(totalSpend / 100).toFixed(2)}`,
      sub: `chat $${(data.totals.costCents / 100).toFixed(2)} · guardrail $${(data.totals.guardrailCostCents / 100).toFixed(2)}`,
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="text-muted-foreground text-xs">
        {data.from} → {data.to} (UTC)
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
              {s.label}
            </div>
            <div className="mt-1 font-mono text-foreground text-lg">{s.value}</div>
            {s.sub ? (
              <div className="mt-0.5 text-[10px] text-muted-foreground/70">{s.sub}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
