/**
 * Proposal builders — the only entry point for staging a provider mutation.
 *
 * Each builder loads the cached item snapshot (so the diff renders a real
 * before/after), constructs the matching `Proposal` discriminator, and
 * persists a row in the `Proposal` table. The persisted `payload` JSON
 * column carries the proposal minus the surrogate id (which lives on the
 * row itself); when the executor loads a proposal back into runtime, it
 * re-attaches `row.id` to the payload via `hydrateProposal`.
 *
 * Builders do NOT call provider write methods. That's the executor's job
 * (and the reason why the arch test forbids write-method calls anywhere
 * else under `src/server/`). Writes happen if and only if a human (or the
 * agent's confirm flow) calls `confirmProposal` after seeing the diff.
 */

import "server-only";
import { TRPCError } from "@trpc/server";
import type {
  CommentAddProposal,
  DescriptionPatchProposal,
  ItemCreateProposal,
  MemoryDeleteProposal,
  MemoryWriteProposal,
  Proposal,
  StateChangeProposal,
} from "@/core/proposal-types";
import type { CreateFields, ItemKind, TransitionIntent } from "@/core/types";
import type { Prisma, Proposal as ProposalRow } from "@/db/generated/client";
import type { db as Db } from "@/server/db";
import { snapshotFromRow } from "@/server/proposals/item-snapshot";

type ProposalContext = {
  db: typeof Db;
  projectId: string;
  userId: string;
};

function payloadOf(proposal: Proposal): Record<string, unknown> {
  // Strip the surrogate id from the persisted payload; the row's own id is
  // canonical. Re-attached by `hydrateProposal` on load.
  const { id: _id, ...rest } = proposal;
  return rest as unknown as Record<string, unknown>;
}

async function persist(
  ctx: ProposalContext,
  draft: Omit<Proposal, "id">,
  providerItemId: string | null,
): Promise<ProposalRow> {
  return ctx.db.proposal.create({
    data: {
      projectId: ctx.projectId,
      userId: ctx.userId,
      kind: draft.kind,
      providerItemId,
      payload: payloadOf({ id: "", ...draft } as Proposal) as Prisma.InputJsonValue,
      status: "pending",
    },
  });
}

async function loadCachedItem(ctx: ProposalContext, providerItemId: string) {
  const row = await ctx.db.item.findFirst({
    where: { projectId: ctx.projectId, providerItemId },
  });
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Item '${providerItemId}' not found in cache; sync the project first.`,
    });
  }
  return row;
}

export async function proposeTransition(
  ctx: ProposalContext,
  args: { providerItemId: string; intent: TransitionIntent },
): Promise<ProposalRow> {
  const row = await loadCachedItem(ctx, args.providerItemId);
  const item = snapshotFromRow(row);
  const draft: Omit<StateChangeProposal, "id"> = {
    kind: "state_change",
    item,
    intent: args.intent,
  };
  return persist(ctx, draft, args.providerItemId);
}

export async function proposeDescriptionPatch(
  ctx: ProposalContext,
  args: { providerItemId: string; newMd: string },
): Promise<ProposalRow> {
  const row = await loadCachedItem(ctx, args.providerItemId);
  const item = snapshotFromRow(row);
  if (item.descriptionMd === args.newMd) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "description_patch is a no-op (description unchanged)",
    });
  }
  const draft: Omit<DescriptionPatchProposal, "id"> = {
    kind: "description_patch",
    item,
    newMd: args.newMd,
  };
  return persist(ctx, draft, args.providerItemId);
}

export async function proposeComment(
  ctx: ProposalContext,
  args: { providerItemId: string; bodyMd: string },
): Promise<ProposalRow> {
  if (!args.bodyMd.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "comment body is empty" });
  }
  const row = await loadCachedItem(ctx, args.providerItemId);
  const item = snapshotFromRow(row);
  const draft: Omit<CommentAddProposal, "id"> = {
    kind: "comment_add",
    item,
    bodyMd: args.bodyMd,
  };
  return persist(ctx, draft, args.providerItemId);
}

export async function proposeNewItem(
  ctx: ProposalContext,
  args: { itemKind: ItemKind; fields: CreateFields },
): Promise<ProposalRow> {
  if (!args.fields.title.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "title is required" });
  }
  const draft: Omit<ItemCreateProposal, "id"> = {
    kind: "item_create",
    itemKind: args.itemKind,
    fields: args.fields,
  };
  return persist(ctx, draft, null);
}

export async function proposeMemoryWrite(
  ctx: ProposalContext,
  args: {
    title: string;
    bodyMd: string;
    tags?: readonly string[];
    source?: "user" | "agent";
    memoryId?: string | null;
  },
): Promise<ProposalRow> {
  const title = args.title.trim();
  if (!title) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "memory title is required" });
  }
  let previousTitle = "";
  let previousBodyMd = "";
  if (args.memoryId) {
    const existing = await ctx.db.memoryEntry.findFirst({
      where: { id: args.memoryId, projectId: ctx.projectId },
    });
    if (!existing) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `memory entry '${args.memoryId}' not found`,
      });
    }
    previousTitle = existing.title;
    previousBodyMd = existing.bodyMd;
    if (existing.title === title && existing.bodyMd === args.bodyMd) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "memory_write is a no-op (title and body unchanged)",
      });
    }
  }
  const draft: Omit<MemoryWriteProposal, "id"> = {
    kind: "memory_write",
    projectId: ctx.projectId,
    title,
    bodyMd: args.bodyMd,
    tags: args.tags ?? [],
    source: args.source ?? "user",
    memoryId: args.memoryId ?? null,
    previousTitle,
    previousBodyMd,
  };
  return persist(ctx, draft, null);
}

export async function proposeMemoryDelete(
  ctx: ProposalContext,
  args: { memoryId: string },
): Promise<ProposalRow> {
  const existing = await ctx.db.memoryEntry.findFirst({
    where: { id: args.memoryId, projectId: ctx.projectId },
  });
  if (!existing) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `memory entry '${args.memoryId}' not found`,
    });
  }
  const draft: Omit<MemoryDeleteProposal, "id"> = {
    kind: "memory_delete",
    projectId: ctx.projectId,
    memoryId: existing.id,
    title: existing.title,
  };
  return persist(ctx, draft, null);
}

/**
 * Re-attach the row's surrogate id to its persisted payload, returning a
 * runtime `Proposal` discriminator the executor / diff renderer can use.
 *
 * Throws if the persisted `kind` doesn't match the payload — that would
 * mean the row is corrupt (someone wrote a payload by hand).
 */
export function hydrateProposal(row: ProposalRow): Proposal {
  if (!row.payload || typeof row.payload !== "object") {
    throw new Error(`Proposal ${row.id}: empty or non-object payload`);
  }
  const payload = row.payload as Record<string, unknown>;
  if (payload.kind !== row.kind) {
    throw new Error(
      `Proposal ${row.id}: row.kind='${row.kind}' but payload.kind='${String(payload.kind)}'`,
    );
  }
  return { ...payload, id: row.id } as Proposal;
}
