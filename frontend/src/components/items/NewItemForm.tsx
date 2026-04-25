import type { RefObject } from "react";

import type { DTO } from "~/api/client";
import { Label } from "~/components/common/Label";
import { MarkdownEditor } from "~/components/common/MarkdownEditor";
import { cn } from "~/lib/cn";
import { formatKind } from "~/lib/format";
import { fieldClass } from "~/lib/formClasses";

import { DuplicateSearchPanel } from "./DuplicateSearchPanel";

type ItemKind = DTO["ItemKind"];

interface Props {
  kind: ItemKind;
  kinds: ItemKind[];
  title: string;
  description: string;
  parentId: string;
  assignee: string;
  tagsRaw: string;
  duplicates: DTO["ItemDTO"][] | undefined;
  duplicatesLoading: boolean;
  titleRef: RefObject<HTMLInputElement | null>;
  onKind: (v: ItemKind) => void;
  onTitle: (v: string) => void;
  onDescription: (v: string) => void;
  onParent: (v: string) => void;
  onAssignee: (v: string) => void;
  onTags: (v: string) => void;
}

export function NewItemForm({
  kind,
  kinds,
  title,
  description,
  parentId,
  assignee,
  tagsRaw,
  duplicates,
  duplicatesLoading,
  titleRef,
  onKind,
  onTitle,
  onDescription,
  onParent,
  onAssignee,
  onTags,
}: Props) {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
        <div>
          <Label>Kind</Label>
          <select
            value={kind}
            onChange={(e) => onKind(e.target.value as ItemKind)}
            className={cn(fieldClass, "mt-2")}
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {formatKind(k)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Title</Label>
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => onTitle(e.target.value)}
            placeholder="Short, specific title"
            className={cn(fieldClass, "mt-2")}
          />
        </div>
      </div>

      {title.trim().length >= 3 && (
        <DuplicateSearchPanel loading={duplicatesLoading} duplicates={duplicates ?? []} />
      )}

      <div>
        <Label>Description (markdown)</Label>
        <div className="mt-2 overflow-hidden rounded-xl border border-border">
          <MarkdownEditor
            value={description}
            onChange={onDescription}
            height="200px"
            lineWrapping
            className="text-[13px]"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label>Parent id (optional)</Label>
          <input
            value={parentId}
            onChange={(e) => onParent(e.target.value)}
            placeholder="#123 or provider-id"
            className={cn(fieldClass, "mt-2")}
          />
        </div>
        <div>
          <Label>Assignee (optional)</Label>
          <input
            value={assignee}
            onChange={(e) => onAssignee(e.target.value)}
            placeholder="@me or user handle"
            className={cn(fieldClass, "mt-2")}
          />
        </div>
        <div>
          <Label>Tags (comma-separated)</Label>
          <input
            value={tagsRaw}
            onChange={(e) => onTags(e.target.value)}
            placeholder="triage, ux, regression"
            className={cn(fieldClass, "mt-2")}
          />
        </div>
      </div>
    </div>
  );
}
