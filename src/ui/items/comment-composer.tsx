"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";
import { Label } from "@/ui/primitives/label";
import { Textarea } from "@/ui/primitives/textarea";
import { ProposalDialog } from "@/ui/proposals/proposal-dialog";

/**
 * "Add comment" composer rendered at the bottom of the detail pane. Stages
 * a `comment_add` proposal. UI-origin comment proposals auto-confirm by
 * default (`proposals.auto-accept-kinds` ships with `comment_add` enabled),
 * so the typical flow is "type → submit → comment lands". The dialog only
 * opens when the project has opted out of auto-accept for comments.
 */
export function CommentComposer({
  projectSlug,
  providerItemId,
}: {
  projectSlug: string;
  providerItemId: string;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const fieldId = useId();

  const propose = trpc.proposals.proposeComment.useMutation({
    onSuccess: async (res) => {
      setBody("");
      if (res.status === "confirmed") {
        await Promise.all([utils.items.get.invalidate(), utils.proposals.list.invalidate()]);
        router.refresh();
        return;
      }
      setPendingProposalId(res.id);
    },
  });

  const error = propose.error?.message;

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = body.trim();
        if (!trimmed) return;
        propose.mutate({ projectSlug, providerItemId, bodyMd: trimmed });
      }}
    >
      <Label
        htmlFor={fieldId}
        className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider"
      >
        Add comment
      </Label>
      <Textarea
        id={fieldId}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="Write a comment…"
        disabled={propose.isPending}
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="xs" disabled={propose.isPending || !body.trim()}>
          {propose.isPending ? "Posting…" : "Post comment"}
        </Button>
        {error ? <span className="text-destructive text-xs">{error}</span> : null}
      </div>
      <ProposalDialog
        projectSlug={projectSlug}
        proposalId={pendingProposalId}
        onClose={() => setPendingProposalId(null)}
      />
    </form>
  );
}
