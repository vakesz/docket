import { Notice } from "~/components/common/Notice";
import { cn } from "~/lib/cn";

export function RawEditor({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  error: string | null;
}) {
  const lineCount = value ? value.split("\n").length : 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-xs text-fg-muted">
          <span>{lineCount} lines</span>
          <span>{value.length.toLocaleString()} chars</span>
          <span className="ml-auto font-mono text-[11px] text-fg-faint">
            JSON view of masked config
          </span>
        </div>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className={cn(
            "min-h-[480px] w-full flex-1 resize-none bg-transparent px-4 py-4 font-mono text-[13px] leading-6 text-fg outline-none",
            "placeholder:text-fg-faint",
          )}
          style={{ tabSize: 2 }}
        />
      </div>
      {error && (
        <Notice tone="error" title="JSON parse error">
          {error}
        </Notice>
      )}
    </div>
  );
}
