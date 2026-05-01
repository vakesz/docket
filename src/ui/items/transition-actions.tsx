"use client";

import { useState } from "react";
import type { TransitionIntent } from "@/core/types";
import { trpc } from "@/lib/trpc-client";
import { CloseDuplicateDialog } from "@/ui/items/close-duplicate-dialog";
import { Button } from "@/ui/primitives/button";
import { ProposalDialog } from "@/ui/proposals/proposal-dialog";

const INTENT_LABEL: Record<TransitionIntent, string> = {
  start_work: "Start work",
  pause: "Pause",
  block: "Block",
  needs_info: "Needs info",
  close_done: "Close (done)",
  close_wontfix: "Close (won't fix)",
  close_duplicate: "Close (duplicate)",
  reopen: "Reopen",
};

/**
 * Transition action buttons rendered inline in the detail header. Stages a
 * `state_change` proposal and pops the confirm dialog. The `intents` list
 * is computed server-side from the project's provider spec
 * (`availableIntents`) so the UI never offers a button whose plan would be
 * a no-op against the current snapshot.
 *
 * `close_duplicate` is special: before staging, we ask the user which item
 * this one duplicates so the executor can pair the close with a comment
 * naming the canonical item. See `CloseDuplicateDialog`.
 */
export function TransitionActions({
  projectSlug,
  providerItemId,
  intents,
}: {
  projectSlug: string;
  providerItemId: string;
  intents: readonly TransitionIntent[];
}) {
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);
  const [duplicatePickerOpen, setDuplicatePickerOpen] = useState(false);
  const proposeTransition = trpc.proposals.proposeTransition.useMutation({
    onSuccess: (res) => setPendingProposalId(res.id),
  });

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
          onClick={() => {
            if (intent === "close_duplicate") {
              setDuplicatePickerOpen(true);
              return;
            }
            proposeTransition.mutate({ projectSlug, providerItemId, intent });
          }}
        >
          {INTENT_LABEL[intent]}
        </Button>
      ))}
      {error ? <span className="text-destructive text-xs">{error}</span> : null}
      <CloseDuplicateDialog
        projectSlug={projectSlug}
        sourceProviderItemId={providerItemId}
        open={duplicatePickerOpen}
        onOpenChange={setDuplicatePickerOpen}
        onSelect={(canonicalItemId) =>
          proposeTransition.mutate({
            projectSlug,
            providerItemId,
            intent: "close_duplicate",
            canonicalItemId,
          })
        }
      />
      <ProposalDialog
        projectSlug={projectSlug}
        proposalId={pendingProposalId}
        onClose={() => setPendingProposalId(null)}
      />
    </div>
  );
}
