"use client";

import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";

/**
 * Sources pane on the project detail page.
 *
 * Sources are author material the agent reads but never writes
 * (CLAUDE.md rule 6, enforced by `src/__arch__/no-source-mutation-tools.test.ts`).
 * That makes the surface intentionally simple: paste markdown OR upload a
 * `.md`/`.txt`/`.json` file and the body lands in `bodyMd`. Binary upload
 * lives in a later phase, alongside text extraction.
 *
 * Writes hit `sources.create` / `sources.delete` directly — no proposal
 * pipeline, since there is no agent to confirm against.
 */
export function SourcesPane({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const list = trpc.sources.list.useQuery({ projectId, limit: 100 }, { staleTime: 0 });
  const create = trpc.sources.create.useMutation({
    onSuccess: () => utils.sources.list.invalidate({ projectId }),
  });
  const remove = trpc.sources.delete.useMutation({
    onSuccess: () => utils.sources.list.invalidate({ projectId }),
  });

  const [draftTitle, setDraftTitle] = useState("");
  const [draftKind, setDraftKind] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const submitNew = async () => {
    const title = draftTitle.trim();
    if (!title) return;
    await create.mutateAsync({
      projectId,
      title,
      kind: draftKind.trim(),
      bodyMd: draftBody,
      tags: [],
    });
    setDraftTitle("");
    setDraftKind("");
    setDraftBody("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleFile = async (file: File) => {
    const text = await file.text();
    setDraftTitle((t) => t || file.name.replace(/\.(md|txt|markdown|json)$/i, ""));
    setDraftBody(text);
  };

  return (
    <section className="flex flex-col gap-3 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Sources
        </h2>
        <span className="text-xs text-muted-foreground">{list.data?.length ?? 0} documents</span>
      </header>

      <form
        className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-muted/20 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submitNew();
        }}
      >
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="Title"
            className="flex-1 rounded-md border border-border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            maxLength={200}
          />
          <input
            type="text"
            value={draftKind}
            onChange={(e) => setDraftKind(e.target.value)}
            placeholder="Kind (e.g. runbook)"
            className="w-40 rounded-md border border-border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            maxLength={64}
          />
        </div>
        <textarea
          value={draftBody}
          onChange={(e) => setDraftBody(e.target.value)}
          placeholder="Paste markdown, or upload a .md / .txt file below."
          rows={4}
          className="rounded-md border border-border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex items-center justify-between gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".md,.markdown,.txt,.json,text/plain,text/markdown,application/json"
            className="text-xs text-muted-foreground"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <Button type="submit" size="sm" disabled={create.isPending || !draftTitle.trim()}>
            {create.isPending ? "Saving…" : "Save source"}
          </Button>
        </div>
        {create.error && <p className="text-xs text-destructive">{create.error.message}</p>}
      </form>

      {list.isPending ? (
        <p className="text-sm italic text-muted-foreground">Loading sources…</p>
      ) : list.data?.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">
          No sources yet. Add one above so the agent has material to cite.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.data?.map((s) => (
            <li
              key={s.id}
              className="flex items-start justify-between gap-3 rounded-md border border-border bg-background p-3"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{s.title}</span>
                  {s.kind && (
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {s.kind}
                    </span>
                  )}
                </div>
                {s.bodyMd && (
                  <p className="line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
                    {s.bodyMd}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={remove.isPending}
                onClick={() => void remove.mutateAsync({ projectId, sourceId: s.id })}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      {remove.error && <p className="text-xs text-destructive">{remove.error.message}</p>}
    </section>
  );
}
