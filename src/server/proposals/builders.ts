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
  ProposalOrigin,
  ReactionToggleProposal,
  StateChangeProposal,
  TagsChangeProposal,
} from "@/core/proposal-types";
import type { CreateFields, ItemKind, TransitionIntent } from "@/core/types";
import type { Prisma, Proposal as ProposalRow } from "@/db/generated/client";
import type { db as Db } from "@/server/db";
import { snapshotFromRow } from "@/server/proposals/item-snapshot";

/**
 * Caller context for proposal builders. `origin` distinguishes a human button
 * click (`"ui"`) from a staged LLM tool call (`"agent"`); the executor's
 * `maybeAutoAccept` allows auto-confirm only on UI-origin rows so the agent
 * can never bypass the human-in-the-loop gate. `origin` is persisted on the
 * `Proposal` row so an audit query later can answer "who staged this".
 */
type ProposalContext = {
  db: typeof Db;
  projectId: string;
  userId: string;
  origin: ProposalOrigin;
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
  advisory: string | null = null,
): Promise<ProposalRow> {
  return ctx.db.proposal.create({
    data: {
      projectId: ctx.projectId,
      userId: ctx.userId,
      kind: draft.kind,
      origin: ctx.origin,
      providerItemId,
      payload: payloadOf({ id: "", ...draft } as Proposal) as Prisma.InputJsonValue,
      status: "pending",
      advisory,
    },
  });
}

/**
 * Tokenize for Jaccard: lowercase, split on non-word, drop tokens shorter
 * than 3 chars to keep stop-words from anchoring the score.
 */
function tokenize(s: string): Set<string> {
  const matches = s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(matches.filter((t) => t.length >= 3));
}

function jaccardSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

const COMMENT_ECHO_THRESHOLD = 0.6;

/**
 * Soft cap for memory entry body size. Memory is loaded into every agent
 * turn's prefix, so giant entries waste tokens and dilute the signal. We
 * advise (not block) at ~4 KB so the human can still confirm a one-off
 * long entry, but the banner nudges them to split it.
 */
const MEMORY_BODY_ADVISORY_BYTES = 4096;

async function loadCachedItem(ctx: ProposalContext, providerItemId: string) {
  // (projectId, providerItemId) is the canonical compound unique on `Item`
  // — using findUnique lets Postgres hit the unique index directly instead
  // of running a generic equality plan via findFirst.
  const row = await ctx.db.item.findUnique({
    where: { projectId_providerItemId: { projectId: ctx.projectId, providerItemId } },
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

/**
 * Format the "Previous version" footer that's automatically appended to
 * description patches. Linear stack — each patch's footer wraps whatever was
 * already in the description, including any earlier footers, so the full
 * authorship chain stays in the body. (The Audit table is the second source
 * of truth for who-patched-when; the footer keeps history visible to humans
 * reading the body in the provider UI.)
 *
 * The agent passes only the new top-level content; this helper appends
 * everything else, so the model can't accidentally double-archive.
 */
export function appendPreviousVersionFooter(
  newMd: string,
  previousMd: string,
  author: string | null,
  timestamp: Date | null,
): string {
  if (!previousMd.trim()) return newMd;
  const date = timestamp ? timestamp.toISOString().slice(0, 10) : null;
  let label: string;
  if (author && date) label = `*Previous version (by ${author}, ${date}):*`;
  else if (author) label = `*Previous version (by ${author}):*`;
  else if (date) label = `*Previous version (${date}):*`;
  else label = `*Previous version:*`;
  return `${newMd.trimEnd()}\n\n---\n\n${label}\n\n${previousMd}`;
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
  const merged = appendPreviousVersionFooter(
    args.newMd,
    item.descriptionMd,
    item.author,
    item.updatedAt ?? item.createdAt,
  );
  const draft: Omit<DescriptionPatchProposal, "id"> = {
    kind: "description_patch",
    item,
    newMd: merged,
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
  // Advisory: flag a comment that closely echoes the item description. This
  // does NOT block staging — the human can still confirm — it just surfaces
  // a banner in the confirm dialog so the human notices an "agent is
  // restating the body" failure mode before approving.
  let advisory: string | null = null;
  const sim = jaccardSimilarity(args.bodyMd, item.descriptionMd);
  if (sim >= COMMENT_ECHO_THRESHOLD) {
    advisory = `This comment shares ${Math.round(sim * 100)}% of its words with the item description. Confirm only if it adds new information.`;
  }
  return persist(ctx, draft, args.providerItemId, advisory);
}

/**
 * Normalize a target tag set: trim, drop empties, dedupe case-insensitively
 * (keeping the first-seen casing), and sort alphabetically. Producing a
 * deterministic order means the same staged proposal renders identically
 * regardless of the order the agent or UI passes labels in.
 */
function normalizeTags(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.sort();
}

export async function proposeTagsChange(
  ctx: ProposalContext,
  args: { providerItemId: string; nextTags: readonly string[] },
): Promise<ProposalRow> {
  const row = await loadCachedItem(ctx, args.providerItemId);
  const item = snapshotFromRow(row);
  const next = normalizeTags(args.nextTags);
  const current = normalizeTags(item.tags);
  if (current.length === next.length && current.every((t, i) => t === next[i])) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "tags_change is a no-op (target tag set matches the current set)",
    });
  }
  const draft: Omit<TagsChangeProposal, "id"> = {
    kind: "tags_change",
    item,
    nextTags: next,
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

export async function proposeReactionToggle(
  ctx: ProposalContext,
  args: {
    providerItemId: string;
    targetKind: "item" | "comment";
    targetId: string;
    reaction: string;
    op: "add" | "remove";
  },
): Promise<ProposalRow> {
  const row = await loadCachedItem(ctx, args.providerItemId);
  const item = snapshotFromRow(row);
  const draft: Omit<ReactionToggleProposal, "id"> = {
    kind: "reaction_toggle",
    item,
    targetKind: args.targetKind,
    targetId: args.targetId,
    reaction: args.reaction,
    op: args.op,
  };
  return persist(ctx, draft, args.providerItemId);
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
  let advisory: string | null = null;
  const byteLen = Buffer.byteLength(args.bodyMd, "utf8");
  if (byteLen > MEMORY_BODY_ADVISORY_BYTES) {
    advisory = `This entry is ${(byteLen / 1024).toFixed(1)} KB. Memory loads into every agent turn — consider splitting into multiple titled entries (one per topic) so the next conversation isn't paying the full body for an unrelated question.`;
  }
  return persist(ctx, draft, null, advisory);
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
