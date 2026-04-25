import { cn } from "~/lib/cn";
import { fieldClass } from "~/lib/formClasses";

export function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={cn(fieldClass, "transition-colors", disabled && "cursor-not-allowed opacity-60")}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  suffix,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <div className="flex w-full items-stretch overflow-hidden rounded-xl border border-border bg-surface focus-within:border-accent">
      <input
        type="number"
        value={value === null ? "" : value}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange(null);
            return;
          }
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : null);
        }}
        min={min}
        max={max}
        step={step}
        className="w-full bg-transparent px-3 py-2 text-sm text-fg outline-none"
      />
      {suffix && (
        <span className="flex items-center border-l border-border bg-bg px-2 text-xs text-fg-muted">
          {suffix}
        </span>
      )}
    </div>
  );
}
