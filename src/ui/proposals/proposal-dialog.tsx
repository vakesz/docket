"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/primitives/dialog";
import { ProposalDiffView } from "@/ui/proposals/proposal-diff-view";

/**
 * Confirm modal for a staged proposal.
 *
 * Renders the diff returned by `proposals.get`, then routes through
 * `proposals.confirm` / `proposals.reject`. The parent owns the open state
 * via `proposalId` (null = closed) so it can chain "stage proposal → open
 * dialog" without lifting any extra state.
 */
export function ProposalDialog({
  projectId,
  proposalId,
  onClose,
}: {
  projectId: string;
  proposalId: string | null;
  onClose: () => void;
}) {
  const open = proposalId !== null;
  const router = useRouter();
  const utils = trpc.useUtils();

  const query = trpc.proposals.get.useQuery(
    { projectId, proposalId: proposalId ?? "" },
    { enabled: open, staleTime: 0 },
  );

  const confirm = trpc.proposals.confirm.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.items.list.invalidate(),
        utils.items.get.invalidate(),
        utils.proposals.list.invalidate(),
      ]);
      // router.refresh() schedules a server-component re-render; running it
      // through a transition keeps the dialog dismissal feeling instant.
      startTransition(() => router.refresh());
      onClose();
    },
  });

  const reject = trpc.proposals.reject.useMutation({
    onSuccess: async () => {
      await utils.proposals.list.invalidate();
      onClose();
    },
  });

  // Auto-dismiss proposals whose diff would be a no-op against the current
  // snapshot (e.g. someone applied the change manually before review). The
  // ref guards against re-firing if reject.mutate triggers a re-render
  // before the proposalId clears.
  //
  // Why `reject.mutate` is NOT in the deps array: the function reference is
  // re-created on every render of the mutation hook, so including it would
  // re-run the effect every render and risk a duplicate auto-reject before
  // the ref-based guard updates. The ref alone is sufficient for idempotency.
  const autoRejectedRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above.
  useEffect(() => {
    if (!proposalId) {
      autoRejectedRef.current = null;
      return;
    }
    if (!query.data?.isEmpty) return;
    if (autoRejectedRef.current === proposalId) return;
    autoRejectedRef.current = proposalId;
    reject.mutate({ projectId, proposalId });
  }, [proposalId, projectId, query.data?.isEmpty]);

  const busy = confirm.isPending || reject.isPending;
  const errorMessage =
    query.error?.message ?? confirm.error?.message ?? reject.error?.message ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Confirm proposal</DialogTitle>
          <DialogDescription>
            Review the change before it&rsquo;s sent to the provider. Nothing has been written yet.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-[6rem]">
          {query.isPending ? (
            <p className="text-sm text-muted-foreground">Loading proposal…</p>
          ) : query.data?.isEmpty ? (
            <p className="text-sm text-muted-foreground">
              Nothing to apply — the change is already reflected. Dismissing…
            </p>
          ) : query.data ? (
            <>
              {query.data.row.advisory ? (
                <Alert variant="warning" className="mb-3">
                  <AlertDescription>Heads up: {query.data.row.advisory}</AlertDescription>
                </Alert>
              ) : null}
              <ProposalDiffView diff={query.data.diff} />
            </>
          ) : null}
        </div>

        {errorMessage ? (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy || !proposalId}
            onClick={() => {
              if (!proposalId) return;
              reject.mutate({ projectId, proposalId });
            }}
          >
            {reject.isPending ? "Rejecting…" : "Reject"}
          </Button>
          <Button
            disabled={busy || !proposalId || !query.data}
            onClick={() => {
              if (!proposalId) return;
              confirm.mutate({ projectId, proposalId });
            }}
          >
            {confirm.isPending ? "Confirming…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
