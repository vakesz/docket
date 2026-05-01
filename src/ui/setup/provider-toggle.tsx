"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/ui/primitives/label";
import { Switch } from "@/ui/primitives/switch";

export function ProviderToggle({
  label,
  checked,
  disabled,
  alreadyConfigured,
  onChange,
  help,
  children,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  alreadyConfigured: boolean;
  onChange: (next: boolean) => void;
  help: React.ReactNode;
  children: React.ReactNode;
}) {
  const switchId = useId();
  return (
    <div className="flex flex-col gap-4 border-border border-t pt-4 first:border-t-0 first:pt-0">
      <div
        className={cn(
          "flex items-start gap-3",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        )}
      >
        <Switch
          id={switchId}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
          className="mt-0.5"
        />
        <Label htmlFor={switchId} className="flex flex-1 flex-col items-start gap-1">
          <span className="flex items-baseline gap-2">
            <span className="font-medium text-foreground">{label}</span>
            {alreadyConfigured ? (
              <span className="text-primary text-xs uppercase tracking-wide">configured</span>
            ) : null}
          </span>
          {help ? <span className="font-normal text-muted-foreground text-xs">{help}</span> : null}
        </Label>
      </div>
      {checked && !disabled ? <div className="flex flex-col gap-3">{children}</div> : null}
    </div>
  );
}
