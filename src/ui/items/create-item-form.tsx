"use client";

import { Plus } from "lucide-react";
import { useEffect, useId, useState } from "react";
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
 * The kind dropdown is populated from `project.capabilities.creatableKinds`
 * — a provider that lists a single kind (e.g. GitHub: `["task"]`) hides
 * the selector entirely so the user isn't presented with a choice the
 * provider can't honor.
 *
 * Tags are entered as a comma-separated string and split on submit so the
 * form stays a single line. Empty assignee / description are normalized to
 * `null` / `""` to match the router's input shape.
 */
export function CreateItemForm({ projectSlug }: { projectSlug: string }) {
  const [open, setOpen] = useState(false);
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);
  const formId = useId();
  const kindId = useId();
  const titleId = useId();
  const descId = useId();
  const assigneeId = useId();
  const tagsId = useId();

  const project = trpc.projects.get.useQuery({ projectSlug }, { staleTime: 5 * 60_000 });
  const creatableKindsList = project.data?.capabilities.creatableKinds ?? [];
  const creatableKinds: readonly ItemKind[] =
    creatableKindsList.length === 0
      ? ["task"]
      : ITEM_KINDS.filter((k) => creatableKindsList.includes(k));
  const defaultKind: ItemKind = creatableKinds[0] ?? "task";

  const [itemKind, setItemKind] = useState<ItemKind>(defaultKind);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState("");
  const [tagsInput, setTagsInput] = useState("");

  // Snap the selected kind into the provider's allowed set whenever the
  // capability list resolves or changes (project switch, slow first load).
  useEffect(() => {
    if (!creatableKinds.includes(itemKind)) setItemKind(defaultKind);
  }, [creatableKinds, defaultKind, itemKind]);

  const propose = trpc.proposals.proposeNewItem.useMutation({
    onSuccess: (res) => {
      setPendingProposalId(res.id);
      setOpen(false);
      resetForm();
    },
  });

  function resetForm() {
    setItemKind(defaultKind);
    setTitle("");
    setDescription("");
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
          <Button type="button" variant="outline" title="Stage a new item">
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
                projectSlug,
                itemKind,
                fields: {
                  title: trimmedTitle,
                  description,
                  parentId: null,
                  assignee: assignee.trim() || null,
                  tags,
                },
              });
            }}
          >
            <div className="grid grid-cols-[8rem_1fr] items-center gap-3">
              {creatableKinds.length > 1 ? (
                <>
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
                      {creatableKinds.map((k) => (
                        <SelectItem key={k} value={k}>
                          {formatKind(k)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              ) : null}

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
                value={description}
                onChange={(e) => setDescription(e.target.value)}
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
        projectSlug={projectSlug}
        proposalId={pendingProposalId}
        onClose={() => setPendingProposalId(null)}
      />
    </>
  );
}
