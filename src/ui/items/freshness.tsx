"use client";

import { formatRelative } from "@/lib/format";
import { type FreshnessTone, freshnessTone } from "@/lib/staleness";
import { useMinuteTick } from "@/lib/use-minute-tick";
import { cn } from "@/lib/utils";

/**
 * Compact "updated 3d ago" stamp that re-tones to amber/red as items age
 * past the configured threshold. The label refreshes on its own ~once a
 * minute so a long-open page doesn't drift out of date.
 */
export function FreshnessStamp({
  updatedAt,
  thresholdDays,
  className,
}: {
  updatedAt: Date | string | null | undefined;
  thresholdDays: number | null;
  className?: string;
}) {
  // Shared minute ticker — 1 setInterval document-wide regardless of how
  // many stamps mount. Read for the side-effect (re-render on change).
  useMinuteTick();

  if (!updatedAt) {
    return <span className={cn("text-muted-foreground/70", className)}>—</span>;
  }

  const tone = freshnessTone(updatedAt, thresholdDays);
  const toneLabel = tone === "warning" ? "aging" : tone === "stale" ? "stale" : null;
  const isoString = typeof updatedAt === "string" ? updatedAt : updatedAt.toISOString();

  return (
    <span
      title={`${new Date(isoString).toLocaleString()}${toneLabel ? ` • ${toneLabel}` : ""}`}
      className={cn(
        "inline-flex items-center gap-1 font-mono text-[10px]",
        tone !== "fresh" && "rounded-full px-1.5 py-0.5",
        toneClassName(tone),
        className,
      )}
    >
      <span>{formatRelative(updatedAt)}</span>
    </span>
  );
}

function toneClassName(tone: FreshnessTone): string {
  switch (tone) {
    case "warning":
      return "bg-warning/10 text-warning";
    case "stale":
      return "bg-stale/10 text-stale";
    default:
      return "text-muted-foreground/70";
  }
}
