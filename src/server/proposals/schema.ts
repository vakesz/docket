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
 * (the upstream `snapshotFromRow` already produced it from a typed Drizzle
 * row, so re-parsing would just burn CPU).
 */

import "server-only";
import { z } from "zod";
import { ITEM_KINDS, ITEM_STATES, TRANSITION_INTENTS } from "@/core/types";

// Mirrors what `snapshotFromRow` produces and what `diff.ts` reads — all
// fields the diff renderer touches are required, the rest of the canonical
// `Item` shape rides through via passthrough so snapshots written by older
// versions of `snapshotFromRow` keep parsing.
const itemSnapshotSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    state: z.enum(ITEM_STATES),
    description: z.string(),
    assignee: z.string().nullable(),
    tags: z.array(z.string()).readonly(),
  })
  .passthrough();

const canonicalItemRefSchema = z.object({
  providerItemId: z.string(),
  title: z.string(),
});

const stateChange = z.object({
  kind: z.literal("state_change"),
  item: itemSnapshotSchema,
  intent: z.enum(TRANSITION_INTENTS),
  canonicalItem: canonicalItemRefSchema.nullable().default(null),
  postedCommentId: z.string().nullable().default(null),
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

const assigneeChange = z.object({
  kind: z.literal("assignee_change"),
  item: itemSnapshotSchema,
  nextAssignee: z.string().nullable(),
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
  source: z.enum(["user", "agent"]),
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

export const proposalPayloadSchema = z
  .discriminatedUnion("kind", [
    stateChange,
    descriptionPatch,
    attachmentUpload,
    itemCreate,
    commentAdd,
    tagsChange,
    assigneeChange,
    reactionToggle,
    memoryWrite,
    memoryDelete,
  ])
  .superRefine((val, ctx) => {
    if (val.kind !== "state_change") return;
    if (val.intent === "close_duplicate" && !val.canonicalItem) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canonicalItem"],
        message: "close_duplicate requires a canonical item reference",
      });
    }
    if (val.intent !== "close_duplicate" && val.canonicalItem) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canonicalItem"],
        message: "canonicalItem only applies to close_duplicate transitions",
      });
    }
  });

export type ProposalPayload = z.infer<typeof proposalPayloadSchema>;

/**
 * Validate-then-encode a proposal payload for the JSON column. The Zod parse
 * runs the same discriminated-union schema we use on the read side, so a
 * builder bug producing the wrong shape fails at write time instead of
 * crashing inside the executor on a future hydrate. Drizzle types JSON
 * columns natively via `.$type<>()`, so the parsed value flows through
 * without further casts.
 */
export function toJsonProposalPayload(draft: unknown): Record<string, unknown> {
  const parsed = proposalPayloadSchema.parse(draft);
  return parsed as Record<string, unknown>;
}
