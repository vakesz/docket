import type { DTO } from "~/api/client";
import { useConfirmProposal, useRejectProposal } from "~/api/hooks";

interface Props {
  proposal: DTO["ProposalDTO"];
  onResolved: () => void;
}

export function ProposalCard({ proposal, onResolved }: Props) {
  const confirm = useConfirmProposal();
  const reject = useRejectProposal();
  const itemId = proposal.item_id ?? "";
  const busy = confirm.isPending || reject.isPending;
  // Surface either action's last failure. The backend re-stages a proposal
  // when confirm fails, so the same id is still valid and the user can retry
  // without re-running the suggest/agent flow.
  const errorMsg = confirm.error?.message ?? reject.error?.message ?? null;

  return (
    <section className="rounded border border-warning bg-warning-bg p-3 text-sm text-warning-fg">
      <header className="mb-2 flex items-center gap-2">
        <span className="rounded bg-warning px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-bg">
          {proposal.kind}
        </span>
        <span className="font-mono text-[11px] text-warning-fg">Pending confirmation</span>
      </header>
      <pre className="whitespace-pre-wrap rounded bg-surface p-2 font-mono text-xs text-fg">
        {proposal.diff}
      </pre>
      {errorMsg && (
        <div className="mt-2 rounded border border-danger bg-danger-bg p-2 font-mono text-[11px] text-danger-fg">
          {errorMsg}
        </div>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy || !itemId}
          onClick={() =>
            reject.mutate({ itemId, proposalId: proposal.id }, { onSuccess: onResolved })
          }
          className="rounded border border-border bg-surface px-3 py-1 text-xs text-fg hover:bg-surface-alt disabled:opacity-60"
        >
          {reject.isPending ? "Rejecting…" : "Reject"}
        </button>
        <button
          type="button"
          disabled={busy || !itemId}
          onClick={() =>
            confirm.mutate({ itemId, proposalId: proposal.id }, { onSuccess: onResolved })
          }
          className="rounded bg-success px-3 py-1 text-xs font-semibold text-bg hover:opacity-90 disabled:opacity-60"
        >
          {confirm.isPending ? "Confirming…" : errorMsg ? "Retry" : "Confirm"}
        </button>
      </div>
    </section>
  );
}
