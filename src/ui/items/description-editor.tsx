"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Markdown } from "@/ui/markdown/markdown";
import { Button } from "@/ui/primitives/button";
import { Checkbox } from "@/ui/primitives/checkbox";
import { Label } from "@/ui/primitives/label";
import { Textarea } from "@/ui/primitives/textarea";
import { ProposalDialog } from "@/ui/proposals/proposal-dialog";

/**
 * Inline description editor that swaps the read-only Markdown view with a
 * textarea on click. Stages a single `description_patch` proposal on Save.
 * UI-origin description edits are on the auto-accept floor
 * (`AUTO_ACCEPT_FLOOR_KINDS` in `src/server/settings/catalog.ts`), so the
 * change lands immediately unless the system is in read-only mode (in which
 * case the proposal dialog opens for human approval after the freeze lifts).
 *
 * The "Previous version" footer is appended server-side by the proposal
 * builder — the textarea contains only the new top-level content the user
 * is authoring, never the historical archive.
 */
export function DescriptionEditor({
  projectSlug,
  providerItemId,
  description,
}: {
  projectSlug: string;
  providerItemId: string;
  description: string | null;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const fieldId = useId();
  const keepCheckboxId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(description ?? "");
  const [keepPrevious, setKeepPrevious] = useState(false);
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);

  // Sync only when the editor is closed — otherwise a background refetch
  // mid-edit (server-side sync just landed, or a websocket nudge) would
  // silently stomp the user's in-progress draft.
  useEffect(() => {
    if (!editing) setDraft(description ?? "");
  }, [description, editing]);

  const propose = trpc.proposals.proposeDescriptionPatch.useMutation({
    onSuccess: async (res) => {
      setEditing(false);
      setKeepPrevious(false);
      if (res.status === "confirmed") {
        await Promise.all([utils.items.get.invalidate(), utils.items.list.invalidate()]);
        router.refresh();
        return;
      }
      setPendingProposalId(res.id);
    },
  });

  const busy = propose.isPending;
  const dirty = draft !== (description ?? "");
  const error = propose.error?.message;

  const header = (
    <div className="flex h-6 items-center justify-between gap-2">
      <h2 className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
        Description
      </h2>
      {!editing ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => setEditing(true)}
          className="gap-1"
        >
          <Pencil aria-hidden="true" className="size-3" />
          Edit
        </Button>
      ) : null}
    </div>
  );

  if (!editing) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        {description ? (
          <Markdown source={description} />
        ) : (
          <p className="text-muted-foreground/70 text-sm italic">(no description)</p>
        )}
        <ProposalDialog
          projectSlug={projectSlug}
          proposalId={pendingProposalId}
          onClose={() => setPendingProposalId(null)}
        />
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty) {
          setEditing(false);
          return;
        }
        propose.mutate({
          projectSlug,
          providerItemId,
          newDescription: draft,
          includePreviousVersion: keepPrevious,
        });
      }}
    >
      {header}
      <Textarea
        id={fieldId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.max(8, Math.min(24, draft.split("\n").length + 2))}
        placeholder="Write a description…"
        disabled={busy}
        className="font-mono text-sm"
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="submit" size="xs" disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setDraft(description ?? "");
            setKeepPrevious(false);
            setEditing(false);
          }}
        >
          Cancel
        </Button>
        <Label htmlFor={keepCheckboxId} className="font-normal text-muted-foreground text-xs">
          <Checkbox
            id={keepCheckboxId}
            checked={keepPrevious}
            onCheckedChange={(v) => setKeepPrevious(v === true)}
            disabled={busy}
          />
          Keep original below
        </Label>
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
