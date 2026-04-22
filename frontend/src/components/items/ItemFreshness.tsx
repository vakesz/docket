import { useMemo } from "react";

import { useSettings, useStatus } from "~/api/hooks";
import { cn } from "~/lib/cn";
import { formatRelative } from "~/lib/format";
import { type FreshnessTone, freshnessTone, resolveStaleThreshold } from "~/lib/staleness";

export function useStaleThreshold(): number | null {
  const settings = useSettings();
  const status = useStatus();

  return useMemo(
    () => resolveStaleThreshold(settings.data?.config, status.data?.provider_key),
    [settings.data?.config, status.data?.provider_key],
  );
}

export function FreshnessStamp({
  updatedAt,
  thresholdDays,
  className,
}: {
  updatedAt: string | null | undefined;
  thresholdDays: number | null;
  className?: string;
}) {
  if (!updatedAt) {
    return <span className={cn("text-zinc-400", className)}>—</span>;
  }

  const tone = freshnessTone(updatedAt, thresholdDays);
  const toneLabel = tone === "warning" ? "aging" : tone === "stale" ? "stale" : null;

  return (
    <span
      title={`${new Date(updatedAt).toLocaleString()}${toneLabel ? ` • ${toneLabel}` : ""}`}
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
      return "bg-amber-100/80 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300";
    case "stale":
      return "bg-rose-100/80 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300";
    default:
      return "text-zinc-400";
  }
}
