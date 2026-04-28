"use client";

import { Button, Textarea } from "@headlessui/react";
import { useState } from "react";
import { xsAccentButtonClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { ProposalDialog } from "@/ui/proposals/proposal-dialog";

/**
 * "Add comment" composer rendered at the bottom of the detail pane. Stages
 * a `comment_add` proposal so the user can review the diff before the
 * provider write fires.
 */
export function CommentComposer({
  projectId,
  providerItemId,
}: {
  projectId: string;
  providerItemId: string;
}) {
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);
  const [body, setBody] = useState("");

  const propose = trpc.proposals.proposeComment.useMutation({
    onSuccess: (res) => {
      setPendingProposalId(res.id);
      setBody("");
    },
  });

  const error = propose.error?.message;

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = body.trim();
        if (!trimmed) return;
        propose.mutate({ projectId, providerItemId, bodyMd: trimmed });
      }}
    >
      <label
        htmlFor="comment-body"
        className="font-mono text-[11px] uppercase tracking-wider text-fg-muted"
      >
        Add comment
      </label>
      <Textarea
        id="comment-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="Stage a comment for review…"
        className="rounded-md border border-border bg-surface p-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent"
        disabled={propose.isPending}
      />
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          disabled={propose.isPending || !body.trim()}
          className={xsAccentButtonClass}
        >
          {propose.isPending ? "Staging…" : "Stage comment"}
        </Button>
        {error ? <span className="text-xs text-danger-fg">{error}</span> : null}
      </div>
      <ProposalDialog
        projectId={projectId}
        proposalId={pendingProposalId}
        onClose={() => setPendingProposalId(null)}
      />
    </form>
  );
}
