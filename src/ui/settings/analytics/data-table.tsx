"use client";

import { ScrollArea } from "@/ui/primitives/scroll-area";
import type { Bucket } from "@/ui/settings/analytics/types";

export function DataTable({ buckets }: { buckets: Bucket[] }) {
  return (
    <details className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <summary className="cursor-pointer select-none text-foreground text-sm">
        By day (table)
      </summary>
      <ScrollArea className="mt-3 max-h-72">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left font-mono text-[10px] text-muted-foreground uppercase tracking-wide">
              <th className="pb-2">Date</th>
              <th className="pb-2 text-right">Conv</th>
              <th className="pb-2 text-right">Tokens in</th>
              <th className="pb-2 text-right">Tokens out</th>
              <th className="pb-2 text-right">Chat $</th>
              <th className="pb-2 text-right">Guardrail $</th>
              <th className="pb-2 text-right">Total $</th>
            </tr>
          </thead>
          <tbody>
            {[...buckets].reverse().map((b) => {
              const totalIn = b.tokensIn + b.guardrailTokensIn;
              const totalOut = b.tokensOut + b.guardrailTokensOut;
              const totalCost = b.costCents + b.guardrailCostCents;
              return (
                <tr key={b.date} className="border-border border-t">
                  <td className="py-1 font-mono text-foreground">{b.date}</td>
                  <td className="py-1 text-right text-muted-foreground">{b.conversations}</td>
                  <td className="py-1 text-right text-muted-foreground">
                    {totalIn.toLocaleString()}
                  </td>
                  <td className="py-1 text-right text-muted-foreground">
                    {totalOut.toLocaleString()}
                  </td>
                  <td className="py-1 text-right text-foreground">
                    ${(b.costCents / 100).toFixed(3)}
                  </td>
                  <td className="py-1 text-right text-chart-1">
                    ${(b.guardrailCostCents / 100).toFixed(3)}
                  </td>
                  <td className="py-1 text-right font-medium text-foreground">
                    ${(totalCost / 100).toFixed(3)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollArea>
    </details>
  );
}
