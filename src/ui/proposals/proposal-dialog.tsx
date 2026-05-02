"use client";

import dynamic from "next/dynamic";

// next/dynamic with `ssr: false` keeps the dialog body out of the initial
// bundle. The dialog only renders after a user action stages a proposal,
// so first-paint of every items page no longer ships Radix Dialog,
// `<ProposalDiffView>`, or the tRPC mutation hook closures unless needed.
const ProposalDialogImpl = dynamic(
  () => import("./proposal-dialog-impl").then((m) => m.ProposalDialogImpl),
  { ssr: false, loading: () => null },
);

/**
 * Confirm modal for a staged proposal. The parent owns the open state via
 * `proposalId` (null = closed) so it can chain "stage proposal → open
 * dialog" without lifting any extra state.
 */
export function ProposalDialog({
  projectSlug,
  proposalId,
  onClose,
}: {
  projectSlug: string;
  proposalId: string | null;
  onClose: () => void;
}) {
  if (proposalId === null) return null;
  return <ProposalDialogImpl projectSlug={projectSlug} proposalId={proposalId} onClose={onClose} />;
}
