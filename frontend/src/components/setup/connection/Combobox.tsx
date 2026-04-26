import { useMemo } from "react";
import { HelpText } from "~/components/common/FormInputs";
import { cn } from "~/lib/cn";

export function Combobox({
  value,
  options,
  onChange,
  placeholder,
  loading,
  emptyHint,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
  loading?: boolean;
  emptyHint?: string;
}) {
  const id = useMemo(() => `combo-${Math.random().toString(36).slice(2, 9)}`, []);

  return (
    <>
      <input
        list={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg",
          "focus:border-accent focus:outline-none",
        )}
      />
      <datalist id={id}>
        {options.map((opt) => (
          <option key={opt} value={opt} />
        ))}
      </datalist>
      {loading && <span className="text-xs text-fg-muted">Loading…</span>}
      {!loading && options.length === 0 && emptyHint && <HelpText>{emptyHint}</HelpText>}
    </>
  );
}
