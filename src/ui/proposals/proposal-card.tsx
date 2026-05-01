"use client";

import { ChevronDown, Maximize2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Badge } from "@/ui/primitives/badge";
import { Button } from "@/ui/primitives/button";
import { ProposalDialog } from "@/ui/proposals/proposal-dialog";
import { ProposalDiffView } from "@/ui/proposals/proposal-diff-view";

const KIND_LABELS: Record<string, string> = {
  state_change: "State change",
  description_patch: "Description patch",
  comment_add: "Comment",
  tags_change: "Tags change",
  item_create: "New item",
  attachment_upload: "Attachment",
  memory_write: "Memory write",
  memory_delete: "Memory delete",
};

/**
 * Inline non-blocking proposal card.
 *
 * Mounted inside the chat scroll region when the agent stages a proposal
 * via the `proposal_staged` SSE event. The card lets the user confirm or
 * reject without leaving the chat — no modal, multiple cards stack so the
 * user can keep typing while reviewing.
 *
 * Auto-applied proposals (memory writes/deletes that match the project's
 * auto-accept policy in `src/server/proposals/executor.ts:maybeAutoAccept`)
 * arrive already in `confirmed`/`executed` state; the card detects this on
 * first load and labels them "Auto-applied" so the user can audit what the
 * agent did without an extra tap.
 */
export function ProposalCard({
  projectSlug,
  proposalId,
  onDismiss,
}: {
  projectSlug: string;
  proposalId: string;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [popoutOpen, setPopoutOpen] = useState(false);
  const utils = trpc.useUtils();

  const query = trpc.proposals.get.useQuery(
    { projectSlug, proposalId },
    { staleTime: 0, refetchOnWindowFocus: false },
  );

  // Distinguish "auto-applied" from "user-confirmed" by snapshotting the
  // status seen on first successful fetch — if the row is already terminal
  // before the user could click anything, the executor handled it.
  const autoAppliedRef = useRef<boolean | null>(null);
  if (autoAppliedRef.current === null && query.data) {
    const r = query.data.row;
    autoAppliedRef.current = r.status === "confirmed" && r.executedAt !== null;
  }
  const autoApplied = autoAppliedRef.current ?? false;

  // Cross-source dismiss: when the proposal is confirmed/rejected via the
  // popout dialog (or any other surface), our local mutation hooks never
  // fire, so the card has to dismiss itself by watching the query's row
  // status. Guard against the auto-applied case — those rows arrive
  // already-terminal and should stay mounted so the user can audit them.
  const observedStatus = query.data?.row.status ?? null;
  const observedExecuted = query.data?.row.executedAt ?? null;
  const terminalStatus =
    observedStatus === "rejected" || (observedStatus === "confirmed" && observedExecuted !== null);
  useEffect(() => {
    if (autoApplied) return;
    if (!terminalStatus) return;
    onDismiss();
  }, [autoApplied, terminalStatus, onDismiss]);

  const confirm = trpc.proposals.confirm.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        utils.items.list.invalidate(),
        utils.items.get.invalidate(),
        utils.proposals.list.invalidate(),
        utils.proposals.get.invalidate({ projectSlug, proposalId }),
      ]);
      // The confirm mutation can resolve with the row bounced back to
      // `pending` if the provider write failed — keep the card mounted in
      // that case so the user sees the error and can retry.
      if (result.status === "confirmed" && result.executedAt !== null) onDismiss();
    },
  });

  const reject = trpc.proposals.reject.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        utils.proposals.list.invalidate(),
        utils.proposals.get.invalidate({ projectSlug, proposalId }),
      ]);
      if (result.status === "rejected") onDismiss();
    },
  });

  const busy = confirm.isPending || reject.isPending;
  const mutationError = confirm.error?.message ?? reject.error?.message ?? null;

  if (query.isPending) {
    return (
      <section className="rounded border border-border bg-card px-3 py-2 text-muted-foreground text-xs">
        Loading proposal…
      </section>
    );
  }
  if (query.error) {
    return (
      <Alert variant="destructive" className="flex items-center gap-2 py-2">
        <AlertDescription className="flex-1">
          Failed to load proposal: {query.error.message}
        </AlertDescription>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-destructive hover:bg-destructive/15 hover:text-destructive"
        >
          <X />
        </Button>
      </Alert>
    );
  }
  if (!query.data) {
    return null;
  }

  const { row, diff } = query.data;
  const kindLabel = KIND_LABELS[row.kind] ?? row.kind;
  const isPending = row.status === "pending";
  // A proposal whose previous confirm attempt failed is reverted to `pending`
  // by the executor with `errorMessage` set, so the user can retry from the
  // same Confirm/Reject buttons. The pill flips to "Failed — retry?" so the
  // banner-style error block is paired with a clear status.
  const isFailed = isPending && row.errorMessage !== null;
  const isSuccess = row.status === "confirmed" && row.executedAt !== null;
  const isRejected = row.status === "rejected";

  let pill: { variant: "success" | "destructive" | "secondary"; text: string } | null = null;
  if (isSuccess) {
    pill = { variant: "success", text: autoApplied ? "Auto-applied" : "Confirmed" };
  } else if (isFailed) {
    pill = { variant: "destructive", text: "Failed — retry?" };
  } else if (isRejected) {
    pill = { variant: "secondary", text: "Rejected" };
  }

  return (
    <section
      className={cn(
        "rounded border bg-card text-foreground text-sm",
        isPending ? "border-primary" : "border-border",
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          <ChevronDown
            className={cn("h-3 w-3 shrink-0 transition-transform", open ? "" : "-rotate-90")}
          />
          <Badge className="font-mono uppercase tracking-wider">propose</Badge>
          <span className="truncate font-medium">{kindLabel}</span>
          {row.providerItemId ? (
            <span className="truncate font-mono text-[11px] text-muted-foreground/70">
              {row.providerItemId}
            </span>
          ) : null}
        </button>

        {pill ? (
          <Badge variant={pill.variant} className="uppercase tracking-wide">
            {pill.text}
          </Badge>
        ) : null}

        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setPopoutOpen(true)}
          aria-label="Open in larger view"
          title="Open in larger view"
        >
          <Maximize2 />
        </Button>

        {isPending ? (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => reject.mutate({ projectSlug, proposalId })}
            >
              {reject.isPending ? "Rejecting…" : "Reject"}
            </Button>
            <Button
              size="xs"
              disabled={busy}
              onClick={() => confirm.mutate({ projectSlug, proposalId })}
            >
              {confirm.isPending ? "Confirming…" : "Confirm"}
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="icon-xs" onClick={onDismiss} aria-label="Dismiss">
            <X />
          </Button>
        )}
      </header>

      {open ? (
        <div className="border-border border-t px-3 py-2">
          {row.advisory ? (
            <Alert variant="warning" className="mb-3">
              <AlertDescription>Heads up: {row.advisory}</AlertDescription>
            </Alert>
          ) : null}
          <ProposalDiffView diff={diff} />
        </div>
      ) : null}

      {isFailed && row.errorMessage ? (
        <div className="border-border border-t px-3 py-2">
          <p className="mb-1 text-muted-foreground text-xs uppercase tracking-wide">
            Provider error
          </p>
          <Alert variant="destructive">
            <AlertDescription>{row.errorMessage}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {mutationError ? (
        <div className="border-border border-t px-3 py-2">
          <Alert variant="destructive">
            <AlertDescription>{mutationError}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <ProposalDialog
        projectSlug={projectSlug}
        proposalId={popoutOpen ? proposalId : null}
        onClose={() => setPopoutOpen(false)}
      />
    </section>
  );
}
