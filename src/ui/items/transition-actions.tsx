"use client";

import { useState } from "react";
import type { ItemState, TransitionIntent } from "@/core/types";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";
import { ProposalDialog } from "@/ui/proposals/proposal-dialog";

/**
 * Pick the transition intents that make sense from a given canonical state.
 * "Pick the action that moves the item out of where it is now" — a blocked
 * item shouldn't expose `block`, an active item shouldn't expose
 * `start_work`. Both providers (GitHub via labels, Azure DevOps via tags)
 * support the full intent set, so the UI shows the same options regardless.
 */
function intentsFor(state: ItemState): TransitionIntent[] {
  switch (state) {
    case "new":
      return ["start_work", "block", "needs_info", "close_done", "close_wontfix"];
    case "active":
      return ["pause", "block", "needs_info", "close_done", "close_wontfix"];
    case "blocked":
      return ["start_work", "needs_info", "close_done", "close_wontfix"];
    case "needs_info":
      return ["start_work", "block", "close_done", "close_wontfix"];
    case "resolved":
    case "closed":
      return ["reopen"];
    default:
      return [];
  }
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
 * Transition action buttons rendered inline in the detail header. Stages a
 * `state_change` proposal and pops the confirm dialog.
 */
export function TransitionActions({
  projectSlug,
  providerItemId,
  state,
}: {
  projectSlug: string;
  providerItemId: string;
  state: ItemState;
}) {
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);
  const proposeTransition = trpc.proposals.proposeTransition.useMutation({
    onSuccess: (res) => setPendingProposalId(res.id),
  });

  const intents = intentsFor(state);
  const error = proposeTransition.error?.message;

  if (intents.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {intents.map((intent) => (
        <Button
          key={intent}
          type="button"
          variant="outline"
          size="xs"
          disabled={proposeTransition.isPending}
          onClick={() => proposeTransition.mutate({ projectSlug, providerItemId, intent })}
        >
          {INTENT_LABEL[intent]}
        </Button>
      ))}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
      <ProposalDialog
        projectSlug={projectSlug}
        proposalId={pendingProposalId}
        onClose={() => setPendingProposalId(null)}
      />
    </div>
  );
}
