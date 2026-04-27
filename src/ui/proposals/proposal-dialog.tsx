"use client";

import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
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
      router.refresh();
      onClose();
    },
  });

  const reject = trpc.proposals.reject.useMutation({
    onSuccess: async () => {
      await utils.proposals.list.invalidate();
      onClose();
    },
  });

  const busy = confirm.isPending || reject.isPending;
  const errorMessage =
    query.error?.message ?? confirm.error?.message ?? reject.error?.message ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) {
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm proposal</DialogTitle>
          <DialogDescription>
            Review the change before it&rsquo;s sent to the provider. Nothing has been written yet.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-[6rem]">
          {query.isPending ? (
            <p className="text-sm text-fg-muted">Loading proposal…</p>
          ) : query.data ? (
            <>
              {query.data.row.advisory ? (
                <p className="mb-3 rounded-md border border-warning/40 bg-warning-bg/40 p-2 text-xs text-warning-fg">
                  Heads up: {query.data.row.advisory}
                </p>
              ) : null}
              <ProposalDiffView diff={query.data.diff} />
            </>
          ) : null}
        </div>

        {errorMessage ? (
          <p className="rounded-md border border-danger/40 bg-danger-bg/40 p-2 text-xs text-danger-fg">
            {errorMessage}
          </p>
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
            variant="default"
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
