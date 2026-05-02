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

// Implementation lives here so `proposal-dialog.tsx` can be a thin
// next/dynamic wrapper — the dialog body (Radix Dialog, tRPC mutation
// hooks, ProposalDiffView) is only loaded once a user action stages a
// proposal. The wrapper guarantees `proposalId` is non-null when this
// component mounts.
export function ProposalDialogImpl({
  projectSlug,
  proposalId,
  onClose,
}: {
  projectSlug: string;
  proposalId: string;
  onClose: () => void;
}) {
  const open = true;
  const router = useRouter();
  const utils = trpc.useUtils();

  const query = trpc.proposals.get.useQuery({ projectSlug, proposalId }, { staleTime: 0 });

  const confirm = trpc.proposals.confirm.useMutation({
    onSuccess: async (data) => {
      // The executor returns the row in its terminal state. Provider failures
      // revert to `pending` with `errorMessage` set so the user can retry —
      // keep the dialog open in that case so the error is visible. Refresh
      // the cached row so `query.data.row.errorMessage` flows into the
      // inline alert below.
      if (data.status === "pending" && data.errorMessage !== null) {
        await utils.proposals.get.invalidate({ projectSlug, proposalId: data.id });
        return;
      }
      await Promise.all([
        utils.items.list.invalidate(),
        utils.items.get.invalidate(),
        utils.proposals.list.invalidate(),
        utils.proposals.get.invalidate({ projectSlug, proposalId: data.id }),
      ]);
      // router.refresh() schedules a server-component re-render; running it
      // through a transition keeps the dialog dismissal feeling instant.
      startTransition(() => router.refresh());
      onClose();
    },
  });

  const reject = trpc.proposals.reject.useMutation({
    onSuccess: async (data) => {
      await Promise.all([
        utils.proposals.list.invalidate(),
        utils.proposals.get.invalidate({ projectSlug, proposalId: data.id }),
      ]);
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
    if (!query.data?.isEmpty) return;
    if (autoRejectedRef.current === proposalId) return;
    autoRejectedRef.current = proposalId;
    reject.mutate({ projectSlug, proposalId });
  }, [proposalId, projectSlug, query.data?.isEmpty]);

  const busy = confirm.isPending || reject.isPending;
  // Provider failures surface on the row itself (executor reverts to `pending`
  // with `errorMessage` set). Mutation errors only fire on transport / auth /
  // validation failures, which is why both sources need to feed this banner.
  const providerError = query.data?.row.errorMessage ?? null;
  const errorMessage =
    providerError ??
    query.error?.message ??
    confirm.error?.message ??
    reject.error?.message ??
    null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-4xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Confirm proposal</DialogTitle>
          <DialogDescription>
            Review the change before it&rsquo;s sent to the provider. Nothing has been written yet.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-[6rem] min-w-0">
          {query.isPending ? (
            <p className="text-muted-foreground text-sm">Loading proposal…</p>
          ) : query.data?.isEmpty ? (
            <p className="text-muted-foreground text-sm">
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
            disabled={busy}
            onClick={() => reject.mutate({ projectSlug, proposalId })}
          >
            {reject.isPending ? "Rejecting…" : "Reject"}
          </Button>
          <Button
            disabled={busy || !query.data}
            onClick={() => confirm.mutate({ projectSlug, proposalId })}
          >
            {confirm.isPending ? "Confirming…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
