import { type ReactNode, useState } from "react";
import { cn } from "~/lib/cn";
import { fieldClass } from "~/lib/formClasses";

export function HelpText({ children }: { children: ReactNode }) {
  return <span className="text-xs leading-5 text-fg-muted">{children}</span>;
}

export function Select({
  value,
  options,
  onChange,
  allowCustom,
  placeholder,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  allowCustom?: boolean;
  placeholder?: string;
}) {
  const knownValues = new Set(options.map((o) => o.value));
  const isCustom = allowCustom && value !== "" && !knownValues.has(value);
  const [customMode, setCustomMode] = useState(isCustom);

  if (allowCustom && customMode) {
    return (
      <div className="flex w-full gap-2">
        <TextInput value={value} onChange={onChange} placeholder={placeholder} />
        <button
          type="button"
          onClick={() => {
            setCustomMode(false);
            onChange(options[0]?.value ?? "");
          }}
          className="rounded-xl border border-border px-3 text-xs text-fg-muted hover:bg-surface-alt"
        >
          Preset
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-full gap-2">
      <select value={value} onChange={(e) => onChange(e.target.value)} className={fieldClass}>
        {value === "" && <option value="">{placeholder ?? "— choose —"}</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {allowCustom && (
        <button
          type="button"
          onClick={() => setCustomMode(true)}
          className="rounded-xl border border-border px-3 text-xs text-fg-muted hover:bg-surface-alt"
        >
          Custom
        </button>
      )}
    </div>
  );
}

export function StatusPill({
  tone,
  label,
}: {
  tone: "ok" | "warn" | "error" | "muted";
  label: string;
}) {
  const cls =
    tone === "ok"
      ? "bg-success-bg text-success-fg"
      : tone === "warn"
        ? "bg-warning-bg text-warning-fg"
        : tone === "error"
          ? "bg-danger-bg text-danger-fg"
          : "bg-surface-alt text-fg-muted";
  return <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", cls)}>{label}</span>;
}

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
