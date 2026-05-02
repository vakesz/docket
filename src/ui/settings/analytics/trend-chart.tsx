"use client";

import { useEffect, useRef, useState } from "react";
import { formatDelta, pctChange, shortDate, shortNum } from "@/ui/settings/analytics/format";
import { LegendDot } from "@/ui/settings/analytics/legend-dot";
import type { Bucket } from "@/ui/settings/analytics/types";

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
export function TrendChart({ buckets }: { buckets: Bucket[] }) {
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

  const trend = buildTrend(buckets);

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
        <h4 className="font-medium text-foreground text-sm">Trends</h4>
        <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-muted-foreground uppercase tracking-wide">
          <LegendDot color="bg-primary" label="Chat spend" />
          <LegendDot color="bg-chart-1" label="Guardrail spend" />
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
          className="fill-none stroke-chart-1"
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
              className="fill-chart-1"
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
