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
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy || !itemId}
          onClick={() =>
            reject.mutate({ itemId, proposalId: proposal.id }, { onSuccess: onResolved })
          }
          className="rounded border border-border bg-surface px-3 py-1 text-xs text-fg hover:bg-surface-alt"
        >
          Reject
        </button>
        <button
          type="button"
          disabled={busy || !itemId}
          onClick={() =>
            confirm.mutate({ itemId, proposalId: proposal.id }, { onSuccess: onResolved })
          }
          className="rounded bg-success px-3 py-1 text-xs font-semibold text-bg hover:opacity-90 disabled:opacity-60"
        >
          {confirm.isPending ? "Confirming…" : "Confirm"}
        </button>
      </div>
    </section>
  );
}
