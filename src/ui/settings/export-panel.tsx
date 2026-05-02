"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";

type Props = {
  projectSlug: string;
};

/**
 * Project-scoped export. Bundles memory + sources + the caller's
 * conversations into one JSON file via `projects.export`. The server
 * paginates conversations to bound memory; this panel walks `nextCursor`
 * until exhausted, merges the pages, and triggers a client-side download.
 * Nothing is persisted server-side and no third party sees the payload.
 */
export function ExportPanel({ projectSlug }: Props) {
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
      const firstPage = await utils.projects.export.fetch({ projectSlug, cursor: null });
      if (!firstPage.project) throw new Error("export missing project metadata");

      const allConversations = [...firstPage.conversations];
      let cursor = firstPage.nextCursor;
      while (cursor !== null) {
        const page = await utils.projects.export.fetch({ projectSlug, cursor });
        allConversations.push(...page.conversations);
        cursor = page.nextCursor;
      }

      const data = {
        formatVersion: firstPage.formatVersion,
        generatedAt: firstPage.generatedAt,
        project: firstPage.project,
        memory: firstPage.memory,
        sources: firstPage.sources,
        conversations: allConversations,
        counts: {
          memory: firstPage.counts.memory,
          sources: firstPage.counts.sources,
          conversations: allConversations.length,
          messages: allConversations.reduce((sum, c) => sum + c.messages.length, 0),
        },
      };

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
      <p className="text-muted-foreground text-sm">
        Downloads a single JSON file containing this project's memory, sources, and{" "}
        <span className="font-medium text-foreground">your own</span> conversation history (other
        members' chats are excluded). Nothing leaves your browser; the file is generated on request
        and not retained server-side.
      </p>
      <div className="flex items-center gap-3">
        <Button type="button" onClick={onExport} disabled={busy}>
          {busy ? "Preparing…" : "Download JSON"}
        </Button>
        {last ? (
          <span className="text-muted-foreground text-xs">
            Exported {last.counts.memory} memory · {last.counts.sources} sources ·{" "}
            {last.counts.conversations} conversations ({last.counts.messages} messages,{" "}
            {(last.sizeBytes / 1024).toFixed(1)} KiB).
          </span>
        ) : null}
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
