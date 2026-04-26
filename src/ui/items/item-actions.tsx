"use client";

import { useState } from "react";
import type { ItemState, TransitionIntent } from "@/core/types";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";
import { ProposalDialog } from "@/ui/proposals/proposal-dialog";

const OPEN_STATES: readonly ItemState[] = ["new", "active", "blocked", "needs_info"];

function intentsFor(state: ItemState): TransitionIntent[] {
  if (OPEN_STATES.includes(state)) {
    return ["close_done", "close_wontfix"];
  }
  return ["reopen"];
}

const INTENT_LABEL: Record<TransitionIntent, string> = {
  start_work: "Start work",
  pause: "Pause",
  block: "Block",
  needs_info: "Needs info",
  close_done: "Close (done)",
  close_wontfix: "Close (won't fix)",
  reopen: "Reopen",
};

/**
 * Inline action bar for the item detail page: stages a `state_change` or
 * `comment_add` proposal and opens the confirm dialog with the returned id.
 *
 * Both flows share one `pendingProposalId` so the same `ProposalDialog`
 * instance handles whichever one fires.
 */
export function ItemActions({
  projectId,
  providerItemId,
  state,
}: {
  projectId: string;
  providerItemId: string;
  state: ItemState;
}) {
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState("");

  const proposeTransition = trpc.proposals.proposeTransition.useMutation({
    onSuccess: (res) => setPendingProposalId(res.id),
  });
  const proposeComment = trpc.proposals.proposeComment.useMutation({
    onSuccess: (res) => {
      setPendingProposalId(res.id);
      setCommentBody("");
    },
  });

  const intents = intentsFor(state);
  const transitionError = proposeTransition.error?.message;
  const commentError = proposeComment.error?.message;
  const busy = proposeTransition.isPending || proposeComment.isPending;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Actions
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {intents.map((intent) => (
            <Button
              key={intent}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => proposeTransition.mutate({ projectId, providerItemId, intent })}
            >
              {INTENT_LABEL[intent]}
            </Button>
          ))}
          {transitionError ? (
            <span className="text-xs text-destructive">{transitionError}</span>
          ) : null}
        </div>
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const body = commentBody.trim();
          if (!body) return;
          proposeComment.mutate({ projectId, providerItemId, bodyMd: body });
        }}
      >
        <label
          htmlFor="comment-body"
          className="text-sm font-medium uppercase tracking-wide text-muted-foreground"
        >
          Add comment
        </label>
        <textarea
          id="comment-body"
          value={commentBody}
          onChange={(e) => setCommentBody(e.target.value)}
          rows={3}
          placeholder="Stage a comment for review…"
          className="rounded-md border border-border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          disabled={busy}
        />
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={busy || !commentBody.trim()}>
            {proposeComment.isPending ? "Staging…" : "Stage comment"}
          </Button>
          {commentError ? <span className="text-xs text-destructive">{commentError}</span> : null}
        </div>
      </form>

      <ProposalDialog
        projectId={projectId}
        proposalId={pendingProposalId}
        onClose={() => setPendingProposalId(null)}
      />
    </section>
  );
}
