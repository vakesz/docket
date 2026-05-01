"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Textarea } from "@/ui/primitives/textarea";
import { ProposalDialog } from "@/ui/proposals/proposal-dialog";

/**
 * Project-memory pane on the project detail page.
 *
 * Reads via `trpc.memory.list`, stages writes/deletes through the proposal
 * pipeline (`memory.proposeWrite` / `memory.proposeDelete`), and hands the
 * proposal id off to `<ProposalDialog>` so the user sees a diff before
 * anything lands. The list invalidates on the dialog's `onClose` rather
 * than at submit time — that way the new entry only shows up after the
 * confirm actually executes.
 */
export function MemoryPane({ projectSlug }: { projectSlug: string }) {
  const utils = trpc.useUtils();
  const list = trpc.memory.list.useQuery({ projectSlug, limit: 50 }, { staleTime: 0 });
  const proposeWrite = trpc.memory.proposeWrite.useMutation();
  const proposeDelete = trpc.memory.proposeDelete.useMutation();

  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");

  const submitNew = async () => {
    const title = draftTitle.trim();
    if (!title) return;
    const result = await proposeWrite.mutateAsync({
      projectSlug,
      memoryId: null,
      title,
      bodyMd: draftBody,
      tags: [],
    });
    setDraftTitle("");
    setDraftBody("");
    setPendingProposalId(result.proposalId);
  };

  const submitDelete = async (memoryId: string) => {
    const result = await proposeDelete.mutateAsync({ projectSlug, memoryId });
    setPendingProposalId(result.proposalId);
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
        <Input
          type="text"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          placeholder="Memory title"
          maxLength={200}
        />
        <Textarea
          value={draftBody}
          onChange={(e) => setDraftBody(e.target.value)}
          placeholder="Body (markdown)"
          rows={3}
          maxLength={50_000}
        />
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-xs">{list.data?.length ?? 0} entries</span>
          <Button type="submit" size="xs" disabled={proposeWrite.isPending || !draftTitle.trim()}>
            {proposeWrite.isPending ? "Staging…" : "Propose write"}
          </Button>
        </div>
        {proposeWrite.error && (
          <Alert variant="destructive">
            <AlertDescription>{proposeWrite.error.message}</AlertDescription>
          </Alert>
        )}
      </form>

      {list.isPending ? (
        <p className="text-muted-foreground text-sm italic">Loading memory…</p>
      ) : list.data?.length === 0 ? (
        <p className="rounded-2xl border border-border border-dashed bg-card p-6 text-center text-muted-foreground text-sm">
          No memory entries yet. Stage one above.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.data?.map((m) => (
            <li
              key={m.id}
              className="flex items-start justify-between gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground text-sm">{m.title}</span>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                    {m.source}
                  </span>
                </div>
                {m.bodyMd && (
                  <p className="line-clamp-2 whitespace-pre-wrap text-muted-foreground text-xs">
                    {m.bodyMd}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="destructive"
                size="xs"
                disabled={proposeDelete.isPending}
                onClick={() => void submitDelete(m.id)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      {proposeDelete.error && (
        <Alert variant="destructive">
          <AlertDescription>{proposeDelete.error.message}</AlertDescription>
        </Alert>
      )}

      <ProposalDialog
        projectSlug={projectSlug}
        proposalId={pendingProposalId}
        onClose={() => {
          setPendingProposalId(null);
          void utils.memory.list.invalidate({ projectSlug });
        }}
      />
    </section>
  );
}
