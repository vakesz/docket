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

import type { CreateFields, Item, ItemKind, TransitionIntent } from "@/core/types";

export const PROPOSAL_KINDS = [
  "state_change",
  "description_patch",
  "attachment_upload",
  "item_create",
  "comment_add",
  "memory_write",
  "memory_delete",
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export type StateChangeProposal = {
  kind: "state_change";
  id: string;
  item: Item;
  intent: TransitionIntent;
};

export type DescriptionPatchProposal = {
  kind: "description_patch";
  id: string;
  item: Item;
  newMd: string;
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
  bodyMd: string;
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
export type MemoryWriteProposal = {
  kind: "memory_write";
  id: string;
  projectId: string;
  title: string;
  bodyMd: string;
  tags: readonly string[];
  /** "user" | "agent" — informational. */
  source: string;
  memoryId: string | null;
  previousTitle: string;
  previousBodyMd: string;
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
  | MemoryWriteProposal
  | MemoryDeleteProposal;

export function kindOf(proposal: Proposal): ProposalKind {
  return proposal.kind;
}
