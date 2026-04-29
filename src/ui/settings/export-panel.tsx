"use client";

import { useState } from "react";
import { primaryButtonClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";

type Props = {
  projectId: string;
};

/**
 * Project-scoped export. Bundles memory + sources + the caller's
 * conversations into one JSON file via `projects.export`. Triggers a
 * client-side download — nothing is persisted server-side and no third
 * party sees the payload.
 */
export function ExportPanel({ projectId }: Props) {
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{
    counts: { memory: number; sources: number; conversations: number; messages: number };
    sizeBytes: number;
  } | null>(null);

  const onExport = async () => {
    setError(null);
    setLast(null);
    setBusy(true);
    try {
      const data = await utils.projects.export.fetch({ projectId });
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `docket-export-${data.project.name.replace(/[^\w.-]+/g, "_")}-${stamp}.json`;
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setLast({ counts: data.counts, sizeBytes: blob.size });
    } catch (e) {
      setError(e instanceof Error ? e.message : "export failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Downloads a single JSON file containing this project's memory, sources, and{" "}
        <span className="font-medium text-foreground">your own</span> conversation history (other
        members' chats are excluded). Nothing leaves your browser; the file is generated on request
        and not retained server-side.
      </p>
      <div className="flex items-center gap-3">
        <button type="button" onClick={onExport} disabled={busy} className={primaryButtonClass}>
          {busy ? "Preparing…" : "Download JSON"}
        </button>
        {last ? (
          <span className="text-xs text-muted-foreground">
            Exported {last.counts.memory} memory · {last.counts.sources} sources ·{" "}
            {last.counts.conversations} conversations ({last.counts.messages} messages,{" "}
            {(last.sizeBytes / 1024).toFixed(1)} KiB).
          </span>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
