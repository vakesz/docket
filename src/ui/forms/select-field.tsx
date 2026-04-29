"use client";

import { ChevronDown } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

type Props = ComponentPropsWithoutRef<"select"> & {
  /** Classes for the wrapping `<div>` — use this for layout overrides
   *  like `max-w-xs`, `flex-1`, `min-w-0`. */
  wrapperClassName?: string;
};

/**
 * Native `<select>` styled to match the shadcn `Input` chrome. The
 * platform chevron varies in height across browsers, so this wrapper
 * strips it (`appearance-none`) and overlays a `lucide` ChevronDown that
 * sits at the same baseline as adjacent inputs.
 *
 * NOTE: this is a transitional shim. Each feature folder migration is
 * expected to convert its callsites to the composed shadcn `Select`
 * (`SelectTrigger` + `SelectContent` + `SelectItem`) — the native
 * fallback here exists only because shadcn's Select takes incompatible
 * children, and the conversion is per-callsite, not mechanical.
 */
export function SelectField({ className, wrapperClassName, children, ...rest }: Props) {
  return (
    <div className={cn("relative", wrapperClassName)}>
      {/* `pr-8` is applied LAST so callers can pass padding shorthands
          like `px-3` without collapsing the chevron clearance — twMerge
          resolves the rightmost padding rule, so the overlay never
          collides with the truncated label text. */}
      <select
        {...rest}
        className={cn(
          "h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
          className,
          "pr-8",
        )}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
