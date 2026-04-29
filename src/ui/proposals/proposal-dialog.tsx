"use client";

import {
  Button,
  Description,
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
} from "@headlessui/react";
import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef } from "react";
import { ghostButtonClass, primaryButtonClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
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
      onClose={() => {
        if (!busy) onClose();
      }}
      className="relative z-50"
    >
      <DialogBackdrop className="fixed inset-0 bg-black/50" />
      <div className="fixed inset-0 flex w-screen items-center justify-center p-4">
        <DialogPanel className="grid w-full max-w-2xl gap-4 rounded-lg border border-border bg-card p-6 text-foreground shadow-lg">
          <div className="flex flex-col gap-1.5">
            <DialogTitle className="text-lg font-semibold leading-none tracking-tight">
              Confirm proposal
            </DialogTitle>
            <Description className="text-sm text-muted-foreground">
              Review the change before it&rsquo;s sent to the provider. Nothing has been written
              yet.
            </Description>
          </div>

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
                  <p className="mb-3 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
                    Heads up: {query.data.row.advisory}
                  </p>
                ) : null}
                <ProposalDiffView diff={query.data.diff} />
              </>
            ) : null}
          </div>

          {errorMessage ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {errorMessage}
            </p>
          ) : null}

          <div className="flex flex-row justify-end gap-2">
            <Button
              disabled={busy || !proposalId}
              onClick={() => {
                if (!proposalId) return;
                reject.mutate({ projectId, proposalId });
              }}
              className={ghostButtonClass}
            >
              {reject.isPending ? "Rejecting…" : "Reject"}
            </Button>
            <Button
              disabled={busy || !proposalId || !query.data}
              onClick={() => {
                if (!proposalId) return;
                confirm.mutate({ projectId, proposalId });
              }}
              className={primaryButtonClass}
            >
              {confirm.isPending ? "Confirming…" : "Confirm"}
            </Button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
