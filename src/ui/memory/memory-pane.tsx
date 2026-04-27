"use client";

import { useState } from "react";
import { emptyStateClass, errorMessageClass, fieldClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";
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
export function MemoryPane({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const list = trpc.memory.list.useQuery({ projectId, limit: 50 }, { staleTime: 0 });
  const proposeWrite = trpc.memory.proposeWrite.useMutation();
  const proposeDelete = trpc.memory.proposeDelete.useMutation();

  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");

  const submitNew = async () => {
    const title = draftTitle.trim();
    if (!title) return;
    const result = await proposeWrite.mutateAsync({
      projectId,
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
    const result = await proposeDelete.mutateAsync({ projectId, memoryId });
    setPendingProposalId(result.proposalId);
  };

  return (
    <section className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-2 rounded-2xl border border-dashed border-border bg-surface-alt/40 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submitNew();
        }}
      >
        <input
          type="text"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          placeholder="Memory title"
          className={fieldClass}
          maxLength={200}
        />
        <textarea
          value={draftBody}
          onChange={(e) => setDraftBody(e.target.value)}
          placeholder="Body (markdown)"
          rows={3}
          className={fieldClass}
          maxLength={50_000}
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-fg-muted">{list.data?.length ?? 0} entries</span>
          <Button type="submit" size="sm" disabled={proposeWrite.isPending || !draftTitle.trim()}>
            {proposeWrite.isPending ? "Staging…" : "Propose write"}
          </Button>
        </div>
        {proposeWrite.error && <p className={errorMessageClass}>{proposeWrite.error.message}</p>}
      </form>

      {list.isPending ? (
        <p className="text-sm italic text-fg-muted">Loading memory…</p>
      ) : list.data?.length === 0 ? (
        <p className={emptyStateClass}>No memory entries yet. Stage one above.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.data?.map((m) => (
            <li
              key={m.id}
              className="flex items-start justify-between gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg">{m.title}</span>
                  <span className="text-[10px] uppercase tracking-wide text-fg-muted">
                    {m.source}
                  </span>
                </div>
                {m.bodyMd && (
                  <p className="line-clamp-2 whitespace-pre-wrap text-xs text-fg-muted">
                    {m.bodyMd}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={proposeDelete.isPending}
                onClick={() => void submitDelete(m.id)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      {proposeDelete.error && <p className={errorMessageClass}>{proposeDelete.error.message}</p>}

      <ProposalDialog
        projectId={projectId}
        proposalId={pendingProposalId}
        onClose={() => {
          setPendingProposalId(null);
          void utils.memory.list.invalidate({ projectId });
        }}
      />
    </section>
  );
}
