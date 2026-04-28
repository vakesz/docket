/**
 * Render a JSON diff payload from a `Proposal`.
 *
 * The diff is the only thing the confirm modal needs to render — it spells
 * out exactly what the provider write will do, in human-readable form.
 * The proposal payload itself stays under `Proposal.payload` for the
 * executor; the diff is computed (not stored) so it always reflects the
 * current proposal type definition.
 *
 * Diff shape is a discriminated union mirroring `ProposalKind`. The UI
 * narrows on `kind` and renders the matching panel.
 */

import type { Proposal, ProposalKind } from "@/core/proposal-types";
import type { ItemState, TransitionIntent } from "@/core/types";

export type StateChangeDiff = {
  kind: "state_change";
  itemId: string;
  itemTitle: string;
  intent: TransitionIntent;
  before: ItemState;
};

export type DescriptionPatchDiff = {
  kind: "description_patch";
  itemId: string;
  itemTitle: string;
  before: string;
  after: string;
};

export type AttachmentUploadDiff = {
  kind: "attachment_upload";
  itemId: string;
  itemTitle: string;
  filename: string;
  contentType: string;
  size: number;
};

export type ItemCreateDiff = {
  kind: "item_create";
  itemKind: string;
  title: string;
  descriptionMd: string;
  assignee: string | null;
  tags: readonly string[];
};

export type CommentAddDiff = {
  kind: "comment_add";
  itemId: string;
  itemTitle: string;
  bodyMd: string;
};

export type TagsChangeDiff = {
  kind: "tags_change";
  itemId: string;
  itemTitle: string;
  before: readonly string[];
  after: readonly string[];
  added: readonly string[];
  removed: readonly string[];
};

export type MemoryWriteDiff = {
  kind: "memory_write";
  memoryId: string | null;
  title: string;
  bodyMd: string;
  previousTitle: string;
  previousBodyMd: string;
};

export type MemoryDeleteDiff = {
  kind: "memory_delete";
  memoryId: string;
  title: string;
};

export type ProposalDiff =
  | StateChangeDiff
  | DescriptionPatchDiff
  | AttachmentUploadDiff
  | ItemCreateDiff
  | CommentAddDiff
  | TagsChangeDiff
  | MemoryWriteDiff
  | MemoryDeleteDiff;

/**
 * A proposal is "empty" when confirming it would be a no-op against the
 * current snapshot — usually because somebody already applied the change
 * manually between staging and review. Returning this flag lets the UI
 * silently auto-reject stale entries instead of showing a blank diff.
 *
 * Conservative by design: kinds that always do something (`item_create`,
 * `memory_delete`, `attachment_upload`, `state_change`) are never empty.
 */
export function isEmptyDiff(diff: ProposalDiff): boolean {
  switch (diff.kind) {
    case "comment_add":
      return diff.bodyMd.trim().length === 0;
    case "description_patch":
      return diff.before === diff.after;
    case "tags_change":
      return diff.added.length === 0 && diff.removed.length === 0;
    case "memory_write":
      return (
        diff.memoryId !== null &&
        diff.previousTitle === diff.title &&
        diff.previousBodyMd === diff.bodyMd
      );
    case "state_change":
    case "item_create":
    case "memory_delete":
    case "attachment_upload":
      return false;
  }
}

export function diffOf(proposal: Proposal): ProposalDiff {
  switch (proposal.kind) {
    case "state_change":
      return {
        kind: "state_change",
        itemId: proposal.item.id,
        itemTitle: proposal.item.title,
        intent: proposal.intent,
        before: proposal.item.state,
      };
    case "description_patch":
      return {
        kind: "description_patch",
        itemId: proposal.item.id,
        itemTitle: proposal.item.title,
        before: proposal.item.descriptionMd,
        after: proposal.newMd,
      };
    case "attachment_upload":
      return {
        kind: "attachment_upload",
        itemId: proposal.item.id,
        itemTitle: proposal.item.title,
        filename: proposal.filename,
        contentType: proposal.contentType,
        size: proposal.content.byteLength,
      };
    case "item_create":
      return {
        kind: "item_create",
        itemKind: proposal.itemKind,
        title: proposal.fields.title,
        descriptionMd: proposal.fields.descriptionMd,
        assignee: proposal.fields.assignee,
        tags: proposal.fields.tags,
      };
    case "comment_add":
      return {
        kind: "comment_add",
        itemId: proposal.item.id,
        itemTitle: proposal.item.title,
        bodyMd: proposal.bodyMd,
      };
    case "tags_change": {
      const beforeSet = new Set(proposal.item.tags.map((t) => t.toLowerCase()));
      const afterSet = new Set(proposal.nextTags.map((t) => t.toLowerCase()));
      const added = proposal.nextTags.filter((t) => !beforeSet.has(t.toLowerCase()));
      const removed = proposal.item.tags.filter((t) => !afterSet.has(t.toLowerCase()));
      return {
        kind: "tags_change",
        itemId: proposal.item.id,
        itemTitle: proposal.item.title,
        before: proposal.item.tags,
        after: proposal.nextTags,
        added,
        removed,
      };
    }
    case "memory_write":
      return {
        kind: "memory_write",
        memoryId: proposal.memoryId,
        title: proposal.title,
        bodyMd: proposal.bodyMd,
        previousTitle: proposal.previousTitle,
        previousBodyMd: proposal.previousBodyMd,
      };
    case "memory_delete":
      return {
        kind: "memory_delete",
        memoryId: proposal.memoryId,
        title: proposal.title,
      };
    default: {
      const exhaustive: never = proposal;
      throw new Error(`Unknown proposal kind: ${(exhaustive as { kind: ProposalKind }).kind}`);
    }
  }
}
