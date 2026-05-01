/**
 * Zod schema for the persisted proposal payload.
 *
 * Validates the JSON column on `Proposal` rows on the way back into runtime,
 * so a corrupted row (hand-edited, half-migrated, garbage) fails fast at
 * `hydrateProposal` instead of crashing inside the executor downstream.
 *
 * The schema mirrors `core/proposal-types.ts` but validates only the
 * fields the executor actually reads — the cached `item` snapshot rides
 * through as a shape-checked object without parsing every nested field
 * (the upstream `snapshotFromRow` already produced it from a typed Prisma
 * row, so re-parsing would just burn CPU).
 */

import "server-only";
import { z } from "zod";
import { ITEM_KINDS, TRANSITION_INTENTS } from "@/core/types";

const itemSnapshotSchema = z
  .object({
    id: z.string(),
    providerItemId: z.string(),
    title: z.string(),
    state: z.string(),
  })
  .passthrough();

const stateChange = z.object({
  kind: z.literal("state_change"),
  item: itemSnapshotSchema,
  intent: z.enum(TRANSITION_INTENTS),
});

const descriptionPatch = z.object({
  kind: z.literal("description_patch"),
  item: itemSnapshotSchema,
  newDescription: z.string(),
});

const attachmentUpload = z.object({
  kind: z.literal("attachment_upload"),
  item: itemSnapshotSchema,
  filename: z.string(),
  // Buffer / Uint8Array round-trips through JSON as `{ type: "Buffer", data: number[] }`
  // or a raw object; downstream consumers re-coerce to Uint8Array. Accept
  // either shape without parsing the bytes here.
  content: z.unknown(),
  contentType: z.string(),
});

const itemCreate = z.object({
  kind: z.literal("item_create"),
  itemKind: z.enum(ITEM_KINDS),
  fields: z.object({ title: z.string() }).passthrough(),
});

const commentAdd = z.object({
  kind: z.literal("comment_add"),
  item: itemSnapshotSchema,
  body: z.string(),
});

const tagsChange = z.object({
  kind: z.literal("tags_change"),
  item: itemSnapshotSchema,
  nextTags: z.array(z.string()).readonly(),
});

const reactionToggle = z.object({
  kind: z.literal("reaction_toggle"),
  item: itemSnapshotSchema,
  targetKind: z.enum(["item", "comment"]),
  targetId: z.string(),
  reaction: z.string(),
  op: z.enum(["add", "remove"]),
});

const memoryWrite = z.object({
  kind: z.literal("memory_write"),
  projectId: z.string(),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()).readonly(),
  source: z.string(),
  memoryId: z.string().nullable(),
  previousTitle: z.string(),
  previousBody: z.string(),
});

const memoryDelete = z.object({
  kind: z.literal("memory_delete"),
  projectId: z.string(),
  memoryId: z.string(),
  title: z.string(),
});

export const proposalPayloadSchema = z.discriminatedUnion("kind", [
  stateChange,
  descriptionPatch,
  attachmentUpload,
  itemCreate,
  commentAdd,
  tagsChange,
  reactionToggle,
  memoryWrite,
  memoryDelete,
]);

export type ProposalPayload = z.infer<typeof proposalPayloadSchema>;
