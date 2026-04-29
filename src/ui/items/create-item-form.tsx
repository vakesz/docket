"use client";

import { Plus } from "lucide-react";
import { useId, useState } from "react";
import { ITEM_KINDS, type ItemKind } from "@/core/types";
import { formatKind } from "@/lib/format";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/primitives/dialog";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";
import { Textarea } from "@/ui/primitives/textarea";
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
  const formId = useId();
  const kindId = useId();
  const titleId = useId();
  const descId = useId();
  const assigneeId = useId();
  const tagsId = useId();

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
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && propose.isPending) return;
          setOpen(next);
          if (next) propose.reset();
        }}
      >
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="xs" title="Stage a new item">
            <Plus aria-hidden="true" />
            New
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New item</DialogTitle>
            <DialogDescription>
              Stage a new work item for review. Nothing is sent to the provider until you confirm
              the proposal.
            </DialogDescription>
          </DialogHeader>

          <form
            id={formId}
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
            <div className="grid grid-cols-[8rem_1fr] items-center gap-3">
              <Label htmlFor={kindId} className="text-xs uppercase tracking-wide">
                Kind
              </Label>
              <Select
                value={itemKind}
                onValueChange={(v) => setItemKind(v as ItemKind)}
                disabled={propose.isPending}
              >
                <SelectTrigger id={kindId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ITEM_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {formatKind(k)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Label htmlFor={titleId} className="text-xs uppercase tracking-wide">
                Title
              </Label>
              <Input
                id={titleId}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Short summary"
                required
                disabled={propose.isPending}
              />

              <Label htmlFor={descId} className="self-start text-xs uppercase tracking-wide">
                Description
              </Label>
              <Textarea
                id={descId}
                value={descriptionMd}
                onChange={(e) => setDescriptionMd(e.target.value)}
                rows={5}
                placeholder="Markdown body (optional)"
                disabled={propose.isPending}
              />

              <Label htmlFor={assigneeId} className="text-xs uppercase tracking-wide">
                Assignee
              </Label>
              <Input
                id={assigneeId}
                type="text"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                placeholder="Provider username (optional)"
                disabled={propose.isPending}
              />

              <Label htmlFor={tagsId} className="text-xs uppercase tracking-wide">
                Tags
              </Label>
              <Input
                id={tagsId}
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="comma, separated, labels"
                disabled={propose.isPending}
              />
            </div>

            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </form>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={propose.isPending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" form={formId} disabled={!canSubmit}>
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
