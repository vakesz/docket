"use client";

import { ChevronDown } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";
import { selectFieldClass } from "@/lib/form-classes";
import { cn } from "@/lib/utils";

type Props = ComponentPropsWithoutRef<"select"> & {
  /** Classes for the wrapping `<div>` — use this for layout overrides
   *  like `max-w-xs`, `flex-1`, `min-w-0`. */
  wrapperClassName?: string;
};

/**
 * Native `<select>` styled to match {@link fieldClass} text inputs. The
 * platform chevron varies in height across browsers (especially Safari),
 * so this wrapper strips it and overlays a `lucide` ChevronDown that sits
 * at the same baseline as adjacent inputs. Pass extra select classes
 * (e.g. `text-xs`, `font-mono`) via `className`; layout sizing belongs on
 * `wrapperClassName`.
 */
export function SelectField({ className, wrapperClassName, children, ...rest }: Props) {
  return (
    <div className={cn("relative", wrapperClassName)}>
      <select {...rest} className={cn(selectFieldClass, className)}>
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
      />
    </div>
  );
}
