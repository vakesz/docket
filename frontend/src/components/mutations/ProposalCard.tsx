import type { DTO } from "~/api/client";
import { useConfirmProposal, useRejectProposal } from "~/api/hooks";
import { cn } from "~/lib/cn";

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
    <section className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
      <header className="mb-2 flex items-center gap-2">
        <span className="rounded bg-amber-200 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-amber-900 dark:bg-amber-900 dark:text-amber-100">
          {proposal.kind}
        </span>
        <span className="font-mono text-[11px] text-amber-800 dark:text-amber-200">
          Pending confirmation
        </span>
      </header>
      <pre className="whitespace-pre-wrap rounded bg-white p-2 font-mono text-xs text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
        {proposal.diff}
      </pre>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy || !itemId}
          onClick={() =>
            reject.mutate({ itemId, proposalId: proposal.id }, { onSuccess: onResolved })
          }
          className={cn(
            "rounded border border-zinc-300 px-3 py-1 text-xs hover:bg-white",
            "dark:border-zinc-700 dark:hover:bg-zinc-900",
          )}
        >
          Reject
        </button>
        <button
          type="button"
          disabled={busy || !itemId}
          onClick={() =>
            confirm.mutate({ itemId, proposalId: proposal.id }, { onSuccess: onResolved })
          }
          className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {confirm.isPending ? "Confirming…" : "Confirm"}
        </button>
      </div>
    </section>
  );
}
