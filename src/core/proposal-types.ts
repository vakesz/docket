/**
 * Typed mutation proposals — pure types only.
 *
 * Every write in the system — from a tRPC mutation, a confirm modal, or an
 * LLM tool call — flows through a `Proposal` value. Builders, the diff
 * renderer, and the executor live in `src/server/proposals/`; this file
 * exists only so `core/` can reference proposal shapes without dragging in
 * any provider, db, or server code.
 *
 * The `kind` discriminator strings are part of the wire format — they
 * appear in agent tool replies and in tRPC payloads. Renaming any value is
 * a breaking change for in-flight conversations and clients.
 */

import type { CreateFields, Item, ItemKind, ProviderItemId, TransitionIntent } from "@/core/types";

export const PROPOSAL_KINDS = [
  "state_change",
  "description_patch",
  "attachment_upload",
  "item_create",
  "comment_add",
  "tags_change",
  "assignee_change",
  "reaction_toggle",
  "memory_write",
  "memory_delete",
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/**
 * Origin of a staged proposal. UI-origin proposals from a human button click
 * may auto-confirm under the policy in `src/server/proposals/policy.ts`;
 * agent-origin proposals always require explicit human confirmation.
 *
 * Default at the storage layer is `agent`, so a missing/invalid value fails
 * safe rather than silently auto-confirming.
 */
export const PROPOSAL_ORIGINS = ["ui", "agent"] as const;
export type ProposalOrigin = (typeof PROPOSAL_ORIGINS)[number];

/**
 * Snapshot of the item this proposal claims as the canonical/non-duplicate
 * counterpart. Required when `intent === "close_duplicate"`, forbidden
 * otherwise. The executor pairs the close transition with a comment that
 * names this item, so the duplicate-link survives in the provider history
 * even though neither GitHub nor Azure DevOps has a native "duplicate" reason.
 */
export type CanonicalItemRef = {
  providerItemId: ProviderItemId;
  title: string;
};

export type StateChangeProposal = {
  kind: "state_change";
  id: string;
  item: Item;
  intent: TransitionIntent;
  canonicalItem: CanonicalItemRef | null;
  /**
   * Set after the executor successfully posts the paired duplicate-comment
   * but BEFORE the transition completes. On retry of a failed bundled
   * close_duplicate, the executor uses this to skip re-posting the comment.
   * Always null for non-`close_duplicate` transitions.
   */
  postedCommentId: string | null;
};

export type DescriptionPatchProposal = {
  kind: "description_patch";
  id: string;
  item: Item;
  newDescription: string;
};

export type AttachmentUploadProposal = {
  kind: "attachment_upload";
  id: string;
  item: Item;
  filename: string;
  content: Uint8Array;
  contentType: string;
};

export type ItemCreateProposal = {
  kind: "item_create";
  id: string;
  itemKind: ItemKind;
  fields: CreateFields;
};

export type CommentAddProposal = {
  kind: "comment_add";
  id: string;
  item: Item;
  body: string;
};

/**
 * Stage a rewrite of the item's user-facing tag set.
 *
 * `nextTags` is the full target set (not a delta). The provider preserves
 * its state-encoding labels regardless — `setTags` unions them in before
 * writing — so this proposal only governs the user-facing portion.
 */
export type TagsChangeProposal = {
  kind: "tags_change";
  id: string;
  item: Item;
  nextTags: readonly string[];
};

/**
 * Stage a change to the item's assignee.
 *
 * `nextAssignee` is the provider-native identity string the provider stamps
 * into `Item.assignee` (e.g. a GitHub login or Azure DevOps email/UPN), or
 * `null` to clear the assignment. The diff renderer reads `item.assignee`
 * for the previous value, so callers don't need to thread it explicitly.
 */
export type AssigneeChangeProposal = {
  kind: "assignee_change";
  id: string;
  item: Item;
  nextAssignee: string | null;
};

/**
 * Stage an add-or-remove of a single reaction on either an item or one of
 * its comments. The `op` discriminator decides direction; `reaction` is the
 * provider-declared kind identifier (validated by the provider against its
 * `capabilities.supportedReactions` list — core stays kind-agnostic).
 * `targetKind === "item"` carries the item snapshot in `item`;
 * `targetKind === "comment"` carries the parent item plus the
 * provider-native comment id.
 */
export type ReactionToggleProposal = {
  kind: "reaction_toggle";
  id: string;
  item: Item;
  targetKind: "item" | "comment";
  /** Provider-native id of the reaction target (item id or comment id). */
  targetId: string;
  /** Provider-declared kind identifier. */
  reaction: string;
  op: "add" | "remove";
};

/**
 * Stage a create-or-update of a per-project memory entry.
 *
 * `memoryId === null` means create; otherwise update. For updates, the
 * `previous*` fields are populated by the proposal builder so the diff
 * renderer can show a real before/after — without them the UI would only
 * ever show "what's about to land", which doesn't read like a diff for a
 * human reviewer.
 */
/**
 * Origin of a staged memory write. Mirrors the `MemorySource` enum on the
 * `MemoryEntry` row so the executor can write the value through without a
 * widening cast. Kept here (not imported from `@/db/schema`) to preserve
 * `core/`'s no-DB-imports rule.
 */
export type MemoryWriteSource = "user" | "agent";

export type MemoryWriteProposal = {
  kind: "memory_write";
  id: string;
  projectId: string;
  title: string;
  body: string;
  tags: readonly string[];
  source: MemoryWriteSource;
  memoryId: string | null;
  previousTitle: string;
  previousBody: string;
};

export type MemoryDeleteProposal = {
  kind: "memory_delete";
  id: string;
  projectId: string;
  memoryId: string;
  /** Snapshot at propose time so the diff stays readable after delete. */
  title: string;
};

export type Proposal =
  | StateChangeProposal
  | DescriptionPatchProposal
  | AttachmentUploadProposal
  | ItemCreateProposal
  | CommentAddProposal
  | TagsChangeProposal
  | AssigneeChangeProposal
  | ReactionToggleProposal
  | MemoryWriteProposal
  | MemoryDeleteProposal;
