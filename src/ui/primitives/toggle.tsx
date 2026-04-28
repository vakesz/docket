import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type ToggleProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  size?: "default" | "muted";
  inline?: boolean;
  align?: "center" | "start";
  className?: string;
  ariaLabel?: string;
};

/**
 * On/off slider switch. Uses a hidden checkbox for accessibility +
 * forms; the visual slider is purely CSS so it stays themable. Use
 * everywhere a setting can be enabled or disabled so the look stays
 * consistent across panels.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  size = "default",
  inline = false,
  align = "center",
  className,
  ariaLabel,
}: ToggleProps) {
  const labelText = size === "muted" ? "text-xs text-fg-muted" : "text-sm text-fg";

  return (
    <label
      className={cn(
        inline ? "inline-flex" : "flex",
        align === "start" ? "items-start" : "items-center",
        "gap-2",
        labelText,
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        className,
      )}
    >
      <span className="relative inline-flex h-5 w-9 shrink-0 items-center">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-label={typeof label === "string" ? undefined : ariaLabel}
          className="peer sr-only"
        />
        <span
          aria-hidden
          className={cn(
            "absolute inset-0 rounded-full border border-border bg-surface-alt transition-colors",
            "peer-checked:border-primary peer-checked:bg-primary",
            "peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50",
          )}
        />
        <span
          aria-hidden
          className={cn(
            "relative ml-0.5 inline-block h-4 w-4 rounded-full bg-fg shadow-sm transition-transform",
            "peer-checked:translate-x-4 peer-checked:bg-primary-foreground",
          )}
        />
      </span>
      {label != null ? <span>{label}</span> : null}
    </label>
  );
}
