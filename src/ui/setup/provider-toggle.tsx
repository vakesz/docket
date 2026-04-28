"use client";

import { Field, Label, Switch } from "@headlessui/react";
import { switchThumbClass, switchTrackClass } from "@/lib/form-classes";

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
  return (
    <div className="rounded-2xl border border-border bg-surface-alt p-4">
      <Field
        className={`flex items-start gap-3 ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
      >
        <Switch
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          className={switchTrackClass}
        >
          <span aria-hidden className={switchThumbClass} />
        </Switch>
        <Label as="span" className="flex flex-1 flex-col gap-1">
          <span className="flex items-baseline gap-2">
            <span className="font-medium text-fg">{label}</span>
            {alreadyConfigured ? (
              <span className="text-xs uppercase tracking-wide text-success-fg">configured</span>
            ) : null}
          </span>
          {help ? <span className="text-xs text-fg-muted">{help}</span> : null}
        </Label>
      </Field>
      {checked && !disabled ? <div className="mt-4 flex flex-col gap-3">{children}</div> : null}
    </div>
  );
}
