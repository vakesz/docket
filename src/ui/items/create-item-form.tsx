"use client";

import {
  Button,
  Description,
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Input,
  Textarea,
} from "@headlessui/react";
import { Plus } from "lucide-react";
import { useState } from "react";
import { ITEM_KINDS, type ItemKind } from "@/core/types";
import {
  fieldClass,
  ghostButtonClass,
  primaryButtonClass,
  xsBorderButtonClass,
} from "@/lib/form-classes";
import { formatKind } from "@/lib/format";
import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";
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
      <Button
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
      </Button>

      <Dialog
        open={open}
        onClose={() => {
          if (!propose.isPending) setOpen(false);
        }}
        className="relative z-50"
      >
        <DialogBackdrop className="fixed inset-0 bg-black/50" />
        <div className="fixed inset-0 flex w-screen items-center justify-center p-4">
          <DialogPanel className="grid w-full max-w-2xl gap-4 rounded-lg border border-border bg-card p-6 text-foreground shadow-lg">
            <div className="flex flex-col gap-1.5">
              <DialogTitle className="text-lg font-semibold leading-none tracking-tight">
                New item
              </DialogTitle>
              <Description className="text-sm text-muted-foreground">
                Stage a new work item for review. Nothing is sent to the provider until you confirm
                the proposal.
              </Description>
            </div>

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
                  className="self-center text-xs uppercase tracking-wide text-muted-foreground"
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
                  className="self-center text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Title
                </label>
                <Input
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
                  className="text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Description
                </label>
                <Textarea
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
                  className="self-center text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Assignee
                </label>
                <Input
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
                  className="self-center text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Tags
                </label>
                <Input
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
                <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </form>

            <div className="flex flex-row justify-end gap-2">
              <Button
                type="button"
                disabled={propose.isPending}
                onClick={() => setOpen(false)}
                className={ghostButtonClass}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                form="create-item-form"
                disabled={!canSubmit}
                className={primaryButtonClass}
              >
                {propose.isPending ? "Staging…" : "Stage proposal"}
              </Button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>

      <ProposalDialog
        projectId={projectId}
        proposalId={pendingProposalId}
        onClose={() => setPendingProposalId(null)}
      />
    </>
  );
}
