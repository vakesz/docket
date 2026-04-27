"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { ITEM_KINDS, type ItemKind } from "@/core/types";
import { fieldClass, xsBorderButtonClass } from "@/lib/form-classes";
import { formatKind } from "@/lib/format";
import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";
import { Button } from "@/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/primitives/dialog";
import { ProposalDialog } from "@/ui/proposals/proposal-dialog";

/**
 * "+ New item" trigger and modal form rendered at the top of the backlog
 * pane. Stages an `item_create` proposal via `proposals.proposeNewItem`,
 * then hands off to the shared `ProposalDialog` so the user reviews the
 * diff and confirms before the provider write fires.
 *
 * Tags are entered as a comma-separated string and split on submit so the
 * form stays a single line. Empty assignee / description are normalized to
 * `null` / `""` to match the router's input shape.
 */
export function CreateItemForm({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);

  const [itemKind, setItemKind] = useState<ItemKind>("task");
  const [title, setTitle] = useState("");
  const [descriptionMd, setDescriptionMd] = useState("");
  const [assignee, setAssignee] = useState("");
  const [tagsInput, setTagsInput] = useState("");

  const propose = trpc.proposals.proposeNewItem.useMutation({
    onSuccess: (res) => {
      setPendingProposalId(res.id);
      setOpen(false);
      resetForm();
    },
  });

  function resetForm() {
    setItemKind("task");
    setTitle("");
    setDescriptionMd("");
    setAssignee("");
    setTagsInput("");
  }

  const trimmedTitle = title.trim();
  const canSubmit = !propose.isPending && trimmedTitle.length > 0;
  const error = propose.error?.message;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          propose.reset();
          setOpen(true);
        }}
        className={xsBorderButtonClass}
        title="Stage a new item"
      >
        <Plus aria-hidden="true" className="size-3" />
        New
      </button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!propose.isPending) setOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New item</DialogTitle>
            <DialogDescription>
              Stage a new work item for review. Nothing is sent to the provider until you confirm
              the proposal.
            </DialogDescription>
          </DialogHeader>

          <form
            id="create-item-form"
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSubmit) return;
              const tags = tagsInput
                .split(",")
                .map((t) => t.trim())
                .filter((t) => t.length > 0);
              propose.mutate({
                projectId,
                itemKind,
                fields: {
                  title: trimmedTitle,
                  descriptionMd,
                  parentId: null,
                  assignee: assignee.trim() || null,
                  tags,
                },
              });
            }}
          >
            <div className="grid grid-cols-[8rem_1fr] gap-3">
              <label
                htmlFor="create-item-kind"
                className="self-center text-xs uppercase tracking-wide text-fg-muted"
              >
                Kind
              </label>
              <SelectField
                id="create-item-kind"
                value={itemKind}
                onChange={(e) => setItemKind(e.target.value as ItemKind)}
                disabled={propose.isPending}
              >
                {ITEM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {formatKind(k)}
                  </option>
                ))}
              </SelectField>

              <label
                htmlFor="create-item-title"
                className="self-center text-xs uppercase tracking-wide text-fg-muted"
              >
                Title
              </label>
              <input
                id="create-item-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Short summary"
                required
                className={fieldClass}
                disabled={propose.isPending}
              />

              <label
                htmlFor="create-item-description"
                className="text-xs uppercase tracking-wide text-fg-muted"
              >
                Description
              </label>
              <textarea
                id="create-item-description"
                value={descriptionMd}
                onChange={(e) => setDescriptionMd(e.target.value)}
                rows={5}
                placeholder="Markdown body (optional)"
                className={fieldClass}
                disabled={propose.isPending}
              />

              <label
                htmlFor="create-item-assignee"
                className="self-center text-xs uppercase tracking-wide text-fg-muted"
              >
                Assignee
              </label>
              <input
                id="create-item-assignee"
                type="text"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                placeholder="Provider username (optional)"
                className={fieldClass}
                disabled={propose.isPending}
              />

              <label
                htmlFor="create-item-tags"
                className="self-center text-xs uppercase tracking-wide text-fg-muted"
              >
                Tags
              </label>
              <input
                id="create-item-tags"
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="comma, separated, labels"
                className={fieldClass}
                disabled={propose.isPending}
              />
            </div>

            {error ? (
              <p className="rounded-md border border-danger/40 bg-danger-bg/40 p-2 text-xs text-danger-fg">
                {error}
              </p>
            ) : null}
          </form>

          <DialogFooter>
            <Button
              variant="ghost"
              type="button"
              disabled={propose.isPending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button variant="default" type="submit" form="create-item-form" disabled={!canSubmit}>
              {propose.isPending ? "Staging…" : "Stage proposal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProposalDialog
        projectId={projectId}
        proposalId={pendingProposalId}
        onClose={() => setPendingProposalId(null)}
      />
    </>
  );
}
