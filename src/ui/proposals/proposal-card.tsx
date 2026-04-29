"use client";

import { ChevronDown, X } from "lucide-react";
import { useRef, useState } from "react";
import { metaLabelClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
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
  projectId,
  proposalId,
  onDismiss,
}: {
  projectId: string;
  proposalId: string;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();

  const query = trpc.proposals.get.useQuery(
    { projectId, proposalId },
    { staleTime: 0, refetchOnWindowFocus: false },
  );

  // Distinguish "auto-applied" from "user-confirmed" by snapshotting the
  // status seen on first successful fetch — if the row is already terminal
  // before the user could click anything, the executor handled it.
  const autoAppliedRef = useRef<boolean | null>(null);
  if (autoAppliedRef.current === null && query.data) {
    const r = query.data.row;
    autoAppliedRef.current =
      r.status === "confirmed" && r.executedAt !== null && r.errorMessage === null;
  }
  const autoApplied = autoAppliedRef.current ?? false;

  const confirm = trpc.proposals.confirm.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.items.list.invalidate(),
        utils.items.get.invalidate(),
        utils.proposals.list.invalidate(),
        utils.proposals.get.invalidate({ projectId, proposalId }),
      ]);
    },
  });

  const reject = trpc.proposals.reject.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.proposals.list.invalidate(),
        utils.proposals.get.invalidate({ projectId, proposalId }),
      ]);
    },
  });

  const busy = confirm.isPending || reject.isPending;
  const mutationError = confirm.error?.message ?? reject.error?.message ?? null;

  if (query.isPending) {
    return (
      <section className="rounded border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        Loading proposal…
      </section>
    );
  }
  if (query.error) {
    return (
      <section className="flex items-center gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <span className="flex-1">Failed to load proposal: {query.error.message}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-1 hover:bg-destructive/15"
          aria-label="Dismiss"
        >
          <X className="h-3 w-3" />
        </button>
      </section>
    );
  }
  if (!query.data) {
    return null;
  }

  const { row, diff } = query.data;
  const kindLabel = KIND_LABELS[row.kind] ?? row.kind;
  const isPending = row.status === "pending";
  const isFailed = row.status === "confirmed" && row.errorMessage !== null;
  const isSuccess =
    row.status === "confirmed" && row.executedAt !== null && row.errorMessage === null;
  const isRejected = row.status === "rejected";

  let pill: { tone: "success" | "danger" | "muted"; text: string } | null = null;
  if (isSuccess) {
    pill = { tone: "success", text: autoApplied ? "Auto-applied" : "Confirmed" };
  } else if (isFailed) {
    pill = { tone: "danger", text: "Failed" };
  } else if (isRejected) {
    pill = { tone: "muted", text: "Rejected" };
  }

  return (
    <section
      className={cn(
        "rounded border bg-card text-sm text-foreground",
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
          <span className="rounded bg-primary px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary-foreground">
            propose
          </span>
          <span className="truncate font-medium">{kindLabel}</span>
          {row.providerItemId ? (
            <span className="truncate font-mono text-[11px] text-muted-foreground-faint">
              {row.providerItemId}
            </span>
          ) : null}
        </button>

        {pill ? <StatusPill tone={pill.tone}>{pill.text}</StatusPill> : null}

        {isPending ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => reject.mutate({ projectId, proposalId })}
              className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-60"
            >
              {reject.isPending ? "Rejecting…" : "Reject"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => confirm.mutate({ projectId, proposalId })}
              className="rounded bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {confirm.isPending ? "Confirming…" : "Confirm"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded p-1 text-muted-foreground-faint hover:bg-muted hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </header>

      {open ? (
        <div className="border-t border-border px-3 py-2">
          {row.advisory ? (
            <p className="mb-3 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
              Heads up: {row.advisory}
            </p>
          ) : null}
          <ProposalDiffView diff={diff} />
        </div>
      ) : null}

      {isFailed && row.errorMessage ? (
        <div className="border-t border-border px-3 py-2">
          <p className={cn("mb-1", metaLabelClass)}>Provider error</p>
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {row.errorMessage}
          </p>
        </div>
      ) : null}

      {mutationError ? (
        <div className="border-t border-border px-3 py-2">
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {mutationError}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function StatusPill({
  tone,
  children,
}: {
  tone: "success" | "danger" | "muted";
  children: React.ReactNode;
}) {
  const cls =
    tone === "success"
      ? "border-success/40 bg-success/10 text-success"
      : tone === "danger"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : "border-border bg-muted text-muted-foreground";
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        cls,
      )}
    >
      {children}
    </span>
  );
}
