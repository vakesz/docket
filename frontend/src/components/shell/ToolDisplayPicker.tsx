import { type ToolDisplayMode, useToolDisplayMode } from "~/lib/uiPrefs";

const OPTIONS: { value: ToolDisplayMode; label: string }[] = [
  { value: "show", label: "Show expanded" },
  { value: "collapse", label: "Collapse (click to expand)" },
  { value: "hide", label: "Hide entirely" },
];

/**
 * Compact picker for how chat tool messages render. Persists to localStorage
 * via `useToolDisplayMode`; no backend round-trip and no effect on the TUI.
 */
export function ToolDisplayPicker() {
  const [mode, setMode] = useToolDisplayMode();
  return (
    <label className="flex items-center gap-1 text-xs">
      <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">
        Tool messages
      </span>
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value as ToolDisplayMode)}
        className="rounded border border-border bg-surface px-2 py-0.5 text-xs text-fg focus:border-accent focus:outline-none"
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
