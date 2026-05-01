"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";

type Bucket = {
  date: string;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  guardrailTokensIn: number;
  guardrailTokensOut: number;
  guardrailCostCents: number;
  conversations: number;
};

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

  const peakCost = useMemo(() => {
    if (!data) return 0;
    let p = 0;
    for (const b of data.buckets) {
      const total = b.costCents + b.guardrailCostCents;
      if (total > p) p = total;
    }
    return p;
  }, [data]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Window:</span>
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
          <Label htmlFor={customDaysId} className="text-xs text-muted-foreground">
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

      {isPending ? <p className="text-sm text-muted-foreground/70">Loading…</p> : null}
      {error ? <p className="text-xs text-destructive">{error.message}</p> : null}

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

function TotalsStrip({
  data,
}: {
  data: {
    totals: {
      tokensIn: number;
      tokensOut: number;
      costCents: number;
      guardrailTokensIn: number;
      guardrailTokensOut: number;
      guardrailCostCents: number;
      conversations: number;
    };
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
      <div className="text-xs text-muted-foreground">
        {data.from} → {data.to} (UTC)
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {s.label}
            </div>
            <div className="mt-1 font-mono text-lg text-foreground">{s.value}</div>
            {s.sub ? (
              <div className="mt-0.5 text-[10px] text-muted-foreground/70">{s.sub}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Pure-SVG trend chart. Three series share the same x-axis (one tick
 * per day in the window) but two y-axes: spend in cents on the left,
 * token counts on the right. We also overlay a 7-day trailing moving
 * average for spend so the eye can see the smooth-line direction
 * separately from daily volatility.
 *
 * No chart library — the visualisation is small enough that a few
 * `polyline`s and `circle`s carry their weight, and we get pixel-level
 * control over the theme tokens.
 */
function TrendChart({ buckets }: { buckets: Bucket[] }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(320, Math.floor(entry.contentRect.width));
        setWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const trend = useMemo(() => buildTrend(buckets), [buckets]);

  if (buckets.length === 0 || !trend) return null;

  const padLeft = 48;
  const padRight = 56;
  const padTop = 14;
  const padBottom = 28;
  const innerH = 200;
  const height = innerH + padTop + padBottom;
  const innerW = Math.max(40, width - padLeft - padRight);
  const n = buckets.length;
  const stepX = n > 1 ? innerW / (n - 1) : 0;

  const xAt = (i: number) => padLeft + i * stepX;
  const yCost = (v: number) =>
    padTop + innerH - (trend.peakCost > 0 ? (v / trend.peakCost) * innerH : 0);
  const yTokens = (v: number) =>
    padTop + innerH - (trend.peakTokens > 0 ? (v / trend.peakTokens) * innerH : 0);

  const costLine = buckets.map((b, i) => `${xAt(i)},${yCost(b.costCents)}`).join(" ");
  const guardrailCostLine = buckets
    .map((b, i) => `${xAt(i)},${yCost(b.guardrailCostCents)}`)
    .join(" ");
  const tokensInLine = buckets.map((b, i) => `${xAt(i)},${yTokens(b.tokensIn)}`).join(" ");
  const tokensOutLine = buckets.map((b, i) => `${xAt(i)},${yTokens(b.tokensOut)}`).join(" ");
  const avgLine = trend.movingAverage.map((v, i) => `${xAt(i)},${yCost(v)}`).join(" ");

  // Area fill under the spend curve to ground the chart.
  const costArea = `${padLeft},${padTop + innerH} ${costLine} ${padLeft + innerW},${padTop + innerH}`;

  // 4 horizontal gridlines + the baseline at 0.
  const gridSteps = 4;
  const gridlines = Array.from({ length: gridSteps + 1 }, (_, i) => {
    const y = padTop + innerH - (i / gridSteps) * innerH;
    const cost = (trend.peakCost * i) / gridSteps;
    const tok = (trend.peakTokens * i) / gridSteps;
    return { y, costLabel: `$${(cost / 100).toFixed(2)}`, tokenLabel: shortNum(tok) };
  });

  // Pick a small set of x-axis ticks so the date strip stays readable.
  const tickEvery = Math.max(1, Math.ceil(n / 6));
  const xTicks = buckets
    .map((b, i) => ({ b, i }))
    .filter(({ i }) => i % tickEvery === 0 || i === n - 1);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (n === 0) return;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const localX = ((e.clientX - rect.left) / rect.width) * width - padLeft;
    if (localX < 0 || localX > innerW) {
      setHover(null);
      return;
    }
    const idx = stepX > 0 ? Math.round(localX / stepX) : 0;
    setHover(Math.max(0, Math.min(n - 1, idx)));
  };

  const hovered = hover !== null ? buckets[hover] : null;
  const hoveredAvg = hover !== null ? (trend.movingAverage[hover] ?? null) : null;

  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h4 className="text-sm font-medium text-foreground">Trends</h4>
        <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          <LegendDot color="bg-primary" label="Chat spend" />
          <LegendDot color="bg-warning" label="Guardrail spend" />
          <LegendDot color="bg-primary/50" label="7-day avg" dashed />
          <LegendDot color="bg-muted-foreground" label="Tokens in" />
          <LegendDot color="bg-muted-foreground/70" label="Tokens out" />
        </div>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Daily LLM usage trends"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        className="block touch-none select-none"
      >
        <title>Daily LLM usage trends</title>
        {/* gridlines + axis labels */}
        {gridlines.map((g) => (
          <g key={g.y}>
            <line
              x1={padLeft}
              x2={padLeft + innerW}
              y1={g.y}
              y2={g.y}
              className="stroke-border"
              strokeWidth={1}
              strokeDasharray="2 3"
            />
            <text
              x={padLeft - 6}
              y={g.y}
              className="fill-muted-foreground font-mono text-[9px]"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {g.costLabel}
            </text>
            <text
              x={padLeft + innerW + 6}
              y={g.y}
              className="fill-muted-foreground font-mono text-[9px]"
              textAnchor="start"
              dominantBaseline="middle"
            >
              {g.tokenLabel}
            </text>
          </g>
        ))}
        {/* spend area + line */}
        <polyline points={costArea} className="fill-accent/15 stroke-none" />
        <polyline
          points={costLine}
          className="fill-none stroke-accent"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* guardrail spend (separate line, same y-axis) */}
        <polyline
          points={guardrailCostLine}
          className="fill-none stroke-warning"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* moving average */}
        <polyline
          points={avgLine}
          className="fill-none stroke-accent/70"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* tokens */}
        <polyline
          points={tokensInLine}
          className="fill-none stroke-muted-foreground"
          strokeWidth={1.25}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <polyline
          points={tokensOutLine}
          className="fill-none stroke-muted-foreground/70"
          strokeWidth={1.25}
          strokeDasharray="2 3"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* x-axis ticks */}
        {xTicks.map(({ b, i }) => (
          <text
            key={b.date}
            x={xAt(i)}
            y={padTop + innerH + 14}
            className="fill-muted-foreground/70 font-mono text-[9px]"
            textAnchor="middle"
          >
            {shortDate(b.date)}
          </text>
        ))}
        {/* hover crosshair + dots */}
        {hover !== null && hovered ? (
          <g>
            <line
              x1={xAt(hover)}
              x2={xAt(hover)}
              y1={padTop}
              y2={padTop + innerH}
              className="stroke-muted-foreground/70"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            <circle cx={xAt(hover)} cy={yCost(hovered.costCents)} r={3.5} className="fill-accent" />
            <circle
              cx={xAt(hover)}
              cy={yCost(hovered.guardrailCostCents)}
              r={3}
              className="fill-warning"
            />
            <circle
              cx={xAt(hover)}
              cy={yTokens(hovered.tokensIn)}
              r={2.5}
              className="fill-muted-foreground"
            />
            <circle
              cx={xAt(hover)}
              cy={yTokens(hovered.tokensOut)}
              r={2.5}
              className="fill-muted-foreground/70"
            />
          </g>
        ) : null}
      </svg>
      <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[10px] text-muted-foreground">
        {hovered ? (
          <>
            <span className="text-foreground">{hovered.date}</span>
            <span>chat ${(hovered.costCents / 100).toFixed(3)}</span>
            <span>guardrail ${(hovered.guardrailCostCents / 100).toFixed(3)}</span>
            <span>
              tokens {hovered.tokensIn.toLocaleString()} in / {hovered.tokensOut.toLocaleString()}{" "}
              out
            </span>
            <span>{hovered.conversations} conv</span>
            {hoveredAvg !== null ? <span>7-day avg ${(hoveredAvg / 100).toFixed(3)}</span> : null}
          </>
        ) : (
          <span>
            Δ spend {formatDelta(trend.deltaCostPct)} · Δ tokens {formatDelta(trend.deltaTokensPct)}
            {" — "}
            recent half vs older half of the window.
          </span>
        )}
      </div>
    </div>
  );
}

function LegendDot({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-block h-2 w-3 rounded ${color}`}
        style={
          dashed
            ? {
                backgroundImage:
                  "repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 7px)",
              }
            : undefined
        }
      />
      {label}
    </span>
  );
}

function buildTrend(buckets: Bucket[]) {
  if (buckets.length === 0) return null;
  let peakCost = 0;
  let peakTokens = 0;
  for (const b of buckets) {
    const c = Math.max(b.costCents, b.guardrailCostCents);
    if (c > peakCost) peakCost = c;
    const t = Math.max(b.tokensIn, b.tokensOut);
    if (t > peakTokens) peakTokens = t;
  }
  if (peakCost === 0) peakCost = 1;
  if (peakTokens === 0) peakTokens = 1;

  const window = 7;
  const movingAverage: number[] = new Array(buckets.length);
  let runningSum = 0;
  for (let i = 0; i < buckets.length; i++) {
    runningSum += buckets[i]?.costCents ?? 0;
    if (i >= window) {
      runningSum -= buckets[i - window]?.costCents ?? 0;
    }
    const len = Math.min(window, i + 1);
    movingAverage[i] = runningSum / len;
  }

  // Recent vs older half deltas. The "trend" feel without a regression.
  const half = Math.max(1, Math.floor(buckets.length / 2));
  const olderSlice = buckets.slice(0, half);
  const recentSlice = buckets.slice(-half);
  const sumCost = (rows: Bucket[]) => rows.reduce((a, r) => a + r.costCents, 0);
  const sumTokens = (rows: Bucket[]) => rows.reduce((a, r) => a + r.tokensIn + r.tokensOut, 0);
  const olderCost = sumCost(olderSlice);
  const recentCost = sumCost(recentSlice);
  const olderTokens = sumTokens(olderSlice);
  const recentTokens = sumTokens(recentSlice);
  const deltaCostPct = pctChange(olderCost, recentCost);
  const deltaTokensPct = pctChange(olderTokens, recentTokens);

  return { peakCost, peakTokens, movingAverage, deltaCostPct, deltaTokensPct };
}

function pctChange(older: number, recent: number): number | null {
  if (older === 0 && recent === 0) return 0;
  if (older === 0) return null;
  return ((recent - older) / older) * 100;
}

function formatDelta(pct: number | null): string {
  if (pct === null) return "n/a";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

function shortNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function shortDate(iso: string): string {
  // YYYY-MM-DD → MM-DD
  return iso.length >= 10 ? iso.slice(5) : iso;
}

function BarChart({ buckets, peakCost }: { buckets: Bucket[]; peakCost: number }) {
  if (buckets.length === 0) return null;
  const peak = peakCost > 0 ? peakCost : 1;
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <h4 className="text-sm font-medium text-foreground">Daily spend</h4>
        <div className="flex items-center gap-3 text-[10px] uppercase tracking-wide text-muted-foreground">
          <LegendDot color="bg-primary/70" label="Chat" />
          <LegendDot color="bg-warning/80" label="Guardrail" />
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
                className="w-full bg-warning/80 transition-colors group-hover:bg-warning"
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

function DataTable({ buckets }: { buckets: Bucket[] }) {
  return (
    <details className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <summary className="cursor-pointer select-none text-sm text-foreground">
        By day (table)
      </summary>
      <div className="mt-3 max-h-72 overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
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
                <tr key={b.date} className="border-t border-border">
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
                  <td className="py-1 text-right text-warning">
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
      </div>
    </details>
  );
}
