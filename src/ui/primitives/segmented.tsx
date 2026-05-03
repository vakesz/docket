"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Mutually-exclusive segmented control. Each segment is a `<button>` with
 * `role="radio"` so screen readers announce it as a single-select group;
 * arrow-key navigation falls through to native focus traversal because
 * the segments are tab-stops in document order.
 *
 * Lives in primitives because the surrounding `useSemanticElements` rule
 * would otherwise nag us to swap to native `<input type="radio">`, which
 * can't carry the custom segmented styling without identical overrides.
 */
export function SegmentedGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex overflow-hidden rounded-md border border-border"
    >
      {children}
    </div>
  );
}

export function SegmentedButton({
  selected,
  onClick,
  title,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      title={title}
      data-state={selected ? "on" : "off"}
      className={cn(
        "not-first:border-border not-first:border-l px-2.5 py-1 font-mono text-[10px] lowercase tracking-wide transition-colors",
        selected
          ? "bg-primary text-primary-foreground"
          : "bg-card text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}
