"use client";

import { Button, Textarea } from "@headlessui/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { xsAccentButtonClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { ProposalDialog } from "@/ui/proposals/proposal-dialog";

/**
 * "Add comment" composer rendered at the bottom of the detail pane. Stages
 * a `comment_add` proposal. UI-origin comment proposals auto-confirm by
 * default (`proposals.auto-accept-kinds` ships with `comment_add` enabled),
 * so the typical flow is "type → submit → comment lands". The dialog only
 * opens when the project has opted out of auto-accept for comments.
 */
export function CommentComposer({
  projectId,
  providerItemId,
}: {
  projectId: string;
  providerItemId: string;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);
  const [body, setBody] = useState("");

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
        propose.mutate({ projectId, providerItemId, bodyMd: trimmed });
      }}
    >
      <label
        htmlFor="comment-body"
        className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground"
      >
        Add comment
      </label>
      <Textarea
        id="comment-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="Write a comment…"
        className="rounded-md border border-border bg-card p-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        disabled={propose.isPending}
      />
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          disabled={propose.isPending || !body.trim()}
          className={xsAccentButtonClass}
        >
          {propose.isPending ? "Posting…" : "Post comment"}
        </Button>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
      <ProposalDialog
        projectId={projectId}
        proposalId={pendingProposalId}
        onClose={() => setPendingProposalId(null)}
      />
    </form>
  );
}
