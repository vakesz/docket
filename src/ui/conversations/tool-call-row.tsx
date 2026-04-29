"use client";

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ToolDisplayMode } from "@/lib/ui-prefs";
import { cn } from "@/lib/utils";
import { condenseArgs, safeStringify } from "@/ui/conversations/transcript";

const META_LABEL = "text-xs uppercase tracking-wide text-muted-foreground";

export function ToolCallRow({
  name,
  args,
  result,
  ok,
  mode,
}: {
  name: string;
  args: Record<string, unknown> | null;
  result: string;
  ok: boolean | null;
  mode: ToolDisplayMode;
}) {
  // Initial open state derives from `mode` once; after the user toggles, the
  // row owns its own open state so flipping the global pref doesn't snap-
  // collapse a result they just expanded.
  const [open, setOpen] = useState(mode === "show");

  if (mode === "hide") return null;

  const isMcp = name.includes("__");
  const label = `${isMcp ? "mcp" : "tool"} · ${name}`;
  const status = ok === true ? "✓" : ok === false ? "✗" : "";

  const argsPreview = condenseArgs(args, 100);
  const resultFirstLine = result.split("\n", 1)[0]?.trim() ?? "";
  const fallbackPreview =
    resultFirstLine.length > 100 ? `${resultFirstLine.slice(0, 100)}…` : resultFirstLine;
  const preview = argsPreview || fallbackPreview;

  const errored = ok === false;
  const palette = errored ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning";
  const hoverBg = errored ? "hover:bg-destructive/15" : "hover:bg-warning/15";

  const prettyArgs = args ? safeStringify(args) : null;

  return (
    <div className={cn("mb-3 overflow-hidden rounded", palette)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn("flex w-full items-center gap-2 px-3 py-2 text-left", hoverBg)}
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className={META_LABEL}>{label}</span>
        {status && <span className="font-mono text-[11px]">{status}</span>}
        {!open && preview && (
          <span className="truncate font-mono text-[11px] text-muted-foreground-faint">
            {preview}
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col">
          {prettyArgs !== null && (
            <div className="px-3 pb-2">
              <div className={cn("mb-1", META_LABEL)}>arguments</div>
              <pre className="whitespace-pre-wrap font-mono text-xs">{prettyArgs}</pre>
            </div>
          )}
          {result && (
            <div
              className={cn("px-3 pb-2", prettyArgs !== null && "border-t border-border/40 pt-2")}
            >
              <div className={cn("mb-1", META_LABEL)}>result</div>
              <pre className="whitespace-pre-wrap font-mono text-xs">{result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolCallProgress({
  toolCalls,
  mode,
  streaming,
}: {
  toolCalls: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
    ok: boolean | null;
  }[];
  mode: ToolDisplayMode;
  streaming: boolean;
}) {
  if (mode === "hide") return null;
  if (!streaming && toolCalls.every((tc) => tc.ok !== null)) {
    // Once the turn is done and the persisted transcript catches up,
    // PersistedMessage renders the tool rows. Don't double-show.
    return null;
  }
  return (
    <div className="mb-3 flex flex-col gap-1 rounded border border-dashed border-border px-3 py-1.5 font-mono text-xs text-muted-foreground">
      {toolCalls.map((tc) => {
        const arrow = tc.ok === null ? "→" : tc.ok ? "✓" : "✗";
        const argSummary = condenseArgs(tc.arguments, 80);
        return (
          <div key={tc.callId} className="truncate">
            {arrow} {tc.name}
            {argSummary ? `(${argSummary})` : "()"}
          </div>
        );
      })}
    </div>
  );
}
