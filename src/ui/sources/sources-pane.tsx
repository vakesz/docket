"use client";

import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Textarea } from "@/ui/primitives/textarea";

/**
 * Sources pane on the project detail page.
 *
 * Sources are author material the agent reads but never writes
 * (AGENTS.md rule 6, enforced by `src/__arch__/no-source-mutation-tools.test.ts`).
 * That makes the surface intentionally simple: paste markdown OR upload a
 * `.md`/`.txt`/`.json` file and the body lands in `bodyMd`. Binary upload
 * + text extraction is intentionally deferred until a real need shows up.
 *
 * Writes hit `sources.create` / `sources.delete` directly — no proposal
 * pipeline, since there is no agent to confirm against.
 */
export function SourcesPane({ projectSlug }: { projectSlug: string }) {
  const utils = trpc.useUtils();
  const list = trpc.sources.list.useQuery({ projectSlug, limit: 100 }, { staleTime: 0 });
  const create = trpc.sources.create.useMutation({
    onSuccess: () => utils.sources.list.invalidate({ projectSlug }),
  });
  const remove = trpc.sources.delete.useMutation({
    onSuccess: () => utils.sources.list.invalidate({ projectSlug }),
  });

  const [draftTitle, setDraftTitle] = useState("");
  const [draftKind, setDraftKind] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const submitNew = async () => {
    const title = draftTitle.trim();
    if (!title) return;
    await create.mutateAsync({
      projectSlug,
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
    <section className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-2 rounded-2xl border border-border border-dashed bg-muted/40 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submitNew();
        }}
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Input
              type="text"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="Title"
              maxLength={200}
            />
          </div>
          <div className="w-40 shrink-0">
            <Input
              type="text"
              value={draftKind}
              onChange={(e) => setDraftKind(e.target.value)}
              placeholder="Kind (e.g. runbook)"
              maxLength={64}
            />
          </div>
        </div>
        <Textarea
          value={draftBody}
          onChange={(e) => setDraftBody(e.target.value)}
          placeholder="Paste markdown, or upload a .md / .txt file below."
          rows={4}
        />
        <div className="flex items-center justify-between gap-2">
          <Input
            ref={fileRef}
            type="file"
            accept=".md,.markdown,.txt,.json,text/plain,text/markdown,application/json"
            className="text-muted-foreground text-xs"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <Button type="submit" size="xs" disabled={create.isPending || !draftTitle.trim()}>
            {create.isPending ? "Saving…" : "Save source"}
          </Button>
        </div>
        {create.error && (
          <Alert variant="destructive">
            <AlertDescription>{create.error.message}</AlertDescription>
          </Alert>
        )}
      </form>

      {list.isPending ? (
        <p className="text-muted-foreground text-sm italic">Loading sources…</p>
      ) : list.data?.length === 0 ? (
        <p className="rounded-2xl border border-border border-dashed bg-card p-6 text-center text-muted-foreground text-sm">
          No sources yet. Add one above so the agent has material to cite.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.data?.map((s) => (
            <li
              key={s.id}
              className="flex items-start justify-between gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground text-sm">{s.title}</span>
                  {s.kind && (
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                      {s.kind}
                    </span>
                  )}
                </div>
                {s.bodyMd && (
                  <p className="line-clamp-2 whitespace-pre-wrap text-muted-foreground text-xs">
                    {s.bodyMd}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="destructive"
                size="xs"
                disabled={remove.isPending}
                onClick={() => void remove.mutateAsync({ projectSlug, sourceId: s.id })}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      {remove.error && (
        <Alert variant="destructive">
          <AlertDescription>{remove.error.message}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
