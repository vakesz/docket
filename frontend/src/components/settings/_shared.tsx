import { CircleAlert, Plus, Settings2, Trash2 } from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { HelpText, NumberInput, TextInput } from "~/components/common/FormInputs";
import { Label } from "~/components/common/Label";
import { cn } from "~/lib/cn";

import { makeRowId } from "./_helpers";

export function ModeButton({
  active,
  onClick,
  disabled,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-surface text-fg shadow-sm"
          : "text-fg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-40",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

export function FormField({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      {children}
      {help && <HelpText>{help}</HelpText>}
    </div>
  );
}

export function NumberMapEditor({
  label,
  help,
  value,
  suggestions,
  suffix,
  onChange,
}: {
  label: string;
  help?: string;
  value: Record<string, unknown>;
  suggestions: string[];
  suffix?: string;
  onChange: (next: Record<string, number>) => void;
}) {
  const initialRows = useMemo(
    () =>
      Object.entries(value).map(([k, v]) => ({
        id: makeRowId(k),
        key: k,
        value: typeof v === "number" ? v : Number(v) || 0,
      })),
    [value],
  );
  const [rows, setRows] = useState(initialRows);
  const lastSerializedRef = useRef<string>(JSON.stringify(initialRows));

  useEffect(() => {
    const serialized = JSON.stringify(initialRows);
    if (serialized !== lastSerializedRef.current) {
      setRows(initialRows);
      lastSerializedRef.current = serialized;
    }
  }, [initialRows]);

  const commit = useCallback(
    (next: typeof rows) => {
      setRows(next);
      const out: Record<string, number> = {};
      for (const row of next) {
        const key = row.key.trim();
        if (!key) continue;
        out[key] = row.value;
      }
      lastSerializedRef.current = JSON.stringify(next);
      onChange(out);
    },
    [onChange],
  );

  const addRow = (key = "") => {
    commit([...rows, { id: makeRowId(key), key, value: 0 }]);
  };

  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      {help && <HelpText>{help}</HelpText>}

      <div className="flex flex-col gap-2">
        {rows.length === 0 && (
          <p className="rounded-xl border border-dashed border-border px-3 py-2 text-xs text-fg-muted">
            No overrides set.
          </p>
        )}
        {rows.map((row, idx) => (
          <div key={row.id} className="grid grid-cols-[1fr_140px_auto] items-stretch gap-2">
            <TextInput
              value={row.key}
              onChange={(v) => {
                const next = [...rows];
                next[idx] = { ...row, key: v };
                commit(next);
              }}
              placeholder="provider key"
            />
            <NumberInput
              value={row.value}
              min={0}
              step={1}
              suffix={suffix}
              onChange={(v) => {
                const next = [...rows];
                next[idx] = { ...row, value: v ?? 0 };
                commit(next);
              }}
            />
            <button
              type="button"
              onClick={() => commit(rows.filter((_, i) => i !== idx))}
              className="rounded-xl border border-border px-2 text-fg-muted hover:bg-bg hover:text-danger"
              title="Remove"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => addRow()}
          className="inline-flex items-center gap-1 rounded-xl border border-border px-3 py-1.5 text-xs text-fg-muted hover:bg-surface-alt"
        >
          <Plus className="h-3 w-3" />
          Add override
        </button>
        {suggestions
          .filter((k) => !rows.some((r) => r.key === k))
          .map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => addRow(k)}
              className="rounded-full bg-surface-alt px-2 py-1 font-mono text-[11px] text-fg-muted hover:bg-surface-alt"
            >
              + {k}
            </button>
          ))}
      </div>
    </div>
  );
}

export function PageState({
  title,
  description,
  tone = "neutral",
}: {
  title: string;
  description: string;
  tone?: "neutral" | "error";
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-2xl border border-border bg-surface p-6 text-center shadow-sm">
        <div
          className={cn(
            "mx-auto flex h-11 w-11 items-center justify-center rounded-2xl",
            tone === "error" ? "bg-danger-bg text-danger-fg" : "bg-surface-alt text-fg-muted",
          )}
        >
          {tone === "error" ? (
            <CircleAlert className="h-5 w-5" />
          ) : (
            <Settings2 className="h-5 w-5" />
          )}
        </div>
        <h1 className="mt-4 text-lg font-semibold text-fg">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-fg-muted">{description}</p>
      </div>
    </div>
  );
}
