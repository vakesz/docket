import { formatState } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Single-tone state pill — every canonical state shares the accent tint
 * and the text label is the only differentiator. If state-specific colors
 * ever come back, do it via a per-state token map and per-theme overrides
 * rather than scattering color literals across surfaces.
 */
export function StatePill({ state, className }: { state: string; className?: string }) {
  return (
    <span
      className={cn(
        "rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary",
        className,
      )}
    >
      {formatState(state)}
    </span>
  );
}
