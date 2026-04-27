"use client";

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
      <label className="flex items-baseline gap-3">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1"
        />
        <span className="flex flex-1 flex-col gap-1">
          <span className="flex items-baseline gap-2">
            <span className="font-medium text-fg">{label}</span>
            {alreadyConfigured ? (
              <span className="text-xs uppercase tracking-wide text-success-fg">configured</span>
            ) : null}
          </span>
          {help ? <span className="text-xs text-fg-muted">{help}</span> : null}
        </span>
      </label>
      {checked && !disabled ? <div className="mt-4 flex flex-col gap-3">{children}</div> : null}
    </div>
  );
}
