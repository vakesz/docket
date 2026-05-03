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
import { and, eq } from "drizzle-orm";
import { capCodeSnippets } from "@/agent/post/code-snippet-cap";
import { loadCodeSnippetCapOptions } from "@/agent/post/load-options";
import type {
  AssigneeChangeProposal,
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
import type {
  CreateFields,
  ItemKind,
  ProjectId,
  ProviderItemId,
  TransitionIntent,
  UserId,
} from "@/core/types";
import type { Db } from "@/db";
import { items, memoryEntries, proposals } from "@/db/schema";
import type { Proposal as ProposalRow } from "@/db/schema/types";
import { assertFound } from "@/server/errors";
import { snapshotFromRow } from "@/server/proposals/item-snapshot";
import { proposalPayloadSchema, toJsonProposalPayload } from "@/server/proposals/schema";
import { jaccardSimilarity } from "@/server/recommendations/similarity";

/**
 * Caller context for proposal builders. `origin` distinguishes a human button
 * click (`"ui"`) from a staged LLM tool call (`"agent"`); the executor's
 * `maybeAutoAccept` allows auto-confirm only on UI-origin rows so the agent
 * can never bypass the human-in-the-loop gate. `origin` is persisted on the
 * `Proposal` row so an audit query later can answer "who staged this".
 */
type ProposalContext = {
  db: Db;
  projectId: ProjectId;
  userId: UserId;
  origin: ProposalOrigin;
};

async function persist(
  ctx: ProposalContext,
  draft: Omit<Proposal, "id">,
  providerItemId: ProviderItemId | null,
  advisory: string | null = null,
): Promise<ProposalRow> {
  // The row's own surrogate id is canonical; the payload omits it and
  // `hydrateProposal` re-attaches `row.id` on load. `toJsonProposalPayload`
  // validates against the same discriminated-union schema we hydrate
  // through — a builder shape bug fails here, not in the executor.
  const [row] = await ctx.db
    .insert(proposals)
    .values({
      projectId: ctx.projectId,
      userId: ctx.userId,
      kind: draft.kind,
      origin: ctx.origin,
      providerItemId,
      payload: toJsonProposalPayload(draft),
      status: "pending",
      advisory,
    })
    .returning();
  if (!row) throw new Error("persist: insert returned no row");
  return row;
}

const COMMENT_ECHO_THRESHOLD = 0.6;

/**
 * Soft cap for memory entry body size. Memory is loaded into every agent
 * turn's prefix, so giant entries waste tokens and dilute the signal. We
 * advise (not block) at ~4 KB so the human can still confirm a one-off
 * long entry, but the banner nudges them to split it.
 */
const MEMORY_BODY_ADVISORY_BYTES = 4096;

async function loadCachedItem(ctx: ProposalContext, providerItemId: ProviderItemId) {
  // (projectId, providerItemId) is the canonical compound unique on `Item` —
  // a `findFirst` against both columns hits the same unique index.
  return assertFound(
    await ctx.db.query.items.findFirst({
      where: and(eq(items.projectId, ctx.projectId), eq(items.providerItemId, providerItemId)),
    }),
    `Item '${providerItemId}' not found in cache; sync the project first.`,
  );
}

/**
 * Body of the auto-generated comment that pairs with a `close_duplicate`
 * transition. Single source of truth so the diff renderer and the executor
 * agree byte-for-byte; if either drifted, the diff would lie about what gets
 * posted. Format references the canonical item by both id and title because
 * neither GitHub nor Azure DevOps has a native "duplicate" reason — the
 * comment body is the only durable record of which item this duplicates.
 */
export function buildDuplicateCommentBody(canonical: {
  providerItemId: string;
  title: string;
}): string {
  return `Closing as duplicate of ${canonical.providerItemId} — ${canonical.title}.`;
}

export async function proposeTransition(
  ctx: ProposalContext,
  args: {
    providerItemId: ProviderItemId;
    intent: TransitionIntent;
    canonicalItemId?: ProviderItemId;
  },
): Promise<ProposalRow> {
  const row = await loadCachedItem(ctx, args.providerItemId);
  const item = snapshotFromRow(row);

  if (args.intent === "close_duplicate") {
    if (!args.canonicalItemId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "close_duplicate requires a canonical item id",
      });
    }
    if (args.canonicalItemId === args.providerItemId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "An item cannot be a duplicate of itself.",
      });
    }
    const canonicalRow = await loadCachedItem(ctx, args.canonicalItemId);
    const draft: Omit<StateChangeProposal, "id"> = {
      kind: "state_change",
      item,
      intent: args.intent,
      canonicalItem: {
        providerItemId: canonicalRow.providerItemId,
        title: canonicalRow.title,
      },
      postedCommentId: null,
    };
    return persist(ctx, draft, args.providerItemId);
  }

  if (args.canonicalItemId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "canonicalItemId only applies to close_duplicate transitions",
    });
  }

  const draft: Omit<StateChangeProposal, "id"> = {
    kind: "state_change",
    item,
    intent: args.intent,
    canonicalItem: null,
    postedCommentId: null,
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
  newDescription: string,
  previousDescription: string,
  author: string | null,
  timestamp: Date | null,
): string {
  if (!previousDescription.trim()) return newDescription;
  const date = timestamp ? timestamp.toISOString().slice(0, 10) : null;
  let label: string;
  if (author && date) label = `*Previous version (by ${author}, ${date}):*`;
  else if (author) label = `*Previous version (by ${author}):*`;
  else if (date) label = `*Previous version (${date}):*`;
  else label = `*Previous version:*`;
  return `${newDescription.trimEnd()}\n\n---\n\n${label}\n\n${previousDescription}`;
}

export async function proposeDescriptionPatch(
  ctx: ProposalContext,
  args: {
    providerItemId: ProviderItemId;
    newDescription: string;
    /**
     * When true, the existing description is appended as a "Previous version"
     * footer beneath the new content. When omitted, the default depends on
     * origin: agent-staged rewrites append (the human reviewing the patch
     * still sees what was replaced); UI-origin edits don't (the user already
     * saw the body and submits verbatim, or opts in via the editor checkbox).
     */
    includePreviousVersion?: boolean;
  },
): Promise<ProposalRow> {
  const row = await loadCachedItem(ctx, args.providerItemId);
  const item = snapshotFromRow(row);
  if (item.description === args.newDescription) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "description_patch is a no-op (description unchanged)",
    });
  }
  // Apply the project's code-snippet cap to the new top-level content
  // BEFORE we tack on the "Previous version" footer — the previous body
  // is verbatim history and should not be re-trimmed every patch.
  const capOptions = await loadCodeSnippetCapOptions(ctx.db, ctx.projectId);
  const capped = capCodeSnippets(args.newDescription, capOptions).text;
  // The "Previous version" footer is for agent-staged rewrites where the
  // human is reviewing a model-authored body and wants the original visible
  // beneath it. UI-origin edits already saw the full body in the editor and
  // submit their text verbatim — appending another footer would just stack
  // duplicates of `item.description` (including any prior footer) on every
  // save. The UI exposes an opt-in checkbox so a human can request the
  // footer when they're rewriting and want to preserve the original.
  const includeFooter = args.includePreviousVersion ?? ctx.origin === "agent";
  const merged = includeFooter
    ? appendPreviousVersionFooter(
        capped,
        item.description,
        item.author,
        item.updatedAt ?? item.createdAt,
      )
    : capped;
  const draft: Omit<DescriptionPatchProposal, "id"> = {
    kind: "description_patch",
    item,
    newDescription: merged,
  };
  return persist(ctx, draft, args.providerItemId);
}

export async function proposeComment(
  ctx: ProposalContext,
  args: { providerItemId: ProviderItemId; body: string },
): Promise<ProposalRow> {
  if (!args.body.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "comment body is empty" });
  }
  const row = await loadCachedItem(ctx, args.providerItemId);
  const item = snapshotFromRow(row);
  const capOptions = await loadCodeSnippetCapOptions(ctx.db, ctx.projectId);
  const cappedBody = capCodeSnippets(args.body, capOptions).text;
  if (!cappedBody.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "comment body is empty after the project's code-snippet policy was applied",
    });
  }
  const draft: Omit<CommentAddProposal, "id"> = {
    kind: "comment_add",
    item,
    body: cappedBody,
  };
  // Advisory: flag a comment that closely echoes the item description. This
  // does NOT block staging — the human can still confirm — it just surfaces
  // a banner in the confirm dialog so the human notices an "agent is
  // restating the body" failure mode before approving.
  let advisory: string | null = null;
  const sim = jaccardSimilarity(cappedBody, item.description);
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
  args: { providerItemId: ProviderItemId; nextTags: readonly string[] },
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

export async function proposeAssigneeChange(
  ctx: ProposalContext,
  args: { providerItemId: ProviderItemId; nextAssignee: string | null },
): Promise<ProposalRow> {
  const row = await loadCachedItem(ctx, args.providerItemId);
  const item = snapshotFromRow(row);
  const next = args.nextAssignee?.trim() || null;
  if ((item.assignee ?? null) === next) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "assignee_change is a no-op (assignee unchanged)",
    });
  }
  const draft: Omit<AssigneeChangeProposal, "id"> = {
    kind: "assignee_change",
    item,
    nextAssignee: next,
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
    providerItemId: ProviderItemId;
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
    body: string;
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
  let previousBody = "";
  if (args.memoryId) {
    const existing = assertFound(
      await ctx.db.query.memoryEntries.findFirst({
        where: eq(memoryEntries.id, args.memoryId),
      }),
      `memory entry '${args.memoryId}' not found`,
    );
    if (existing.projectId !== ctx.projectId) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `memory entry '${args.memoryId}' not found`,
      });
    }
    previousTitle = existing.title;
    previousBody = existing.body;
    if (existing.title === title && existing.body === args.body) {
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
    body: args.body,
    tags: args.tags ?? [],
    source: args.source ?? "user",
    memoryId: args.memoryId ?? null,
    previousTitle,
    previousBody,
  };
  let advisory: string | null = null;
  const byteLen = Buffer.byteLength(args.body, "utf8");
  if (byteLen > MEMORY_BODY_ADVISORY_BYTES) {
    advisory = `This entry is ${(byteLen / 1024).toFixed(1)} KB. Memory loads into every agent turn — consider splitting into multiple titled entries (one per topic) so the next conversation isn't paying the full body for an unrelated question.`;
  }
  return persist(ctx, draft, null, advisory);
}

export async function proposeMemoryDelete(
  ctx: ProposalContext,
  args: { memoryId: string },
): Promise<ProposalRow> {
  const existing = assertFound(
    await ctx.db.query.memoryEntries.findFirst({
      where: eq(memoryEntries.id, args.memoryId),
    }),
    `memory entry '${args.memoryId}' not found`,
  );
  if (existing.projectId !== ctx.projectId) {
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
 * The persisted JSON is parsed against `proposalPayloadSchema` (a
 * discriminated union over `kind`) so a corrupt row — bad shape, missing
 * field, mismatched discriminator — fails fast at hydration instead of
 * crashing inside the executor downstream. Cross-checks `row.kind` against
 * the payload discriminator as defence in depth.
 */
export function hydrateProposal(row: ProposalRow): Proposal {
  if (!row.payload || typeof row.payload !== "object") {
    throw new Error(`Proposal ${row.id}: empty or non-object payload`);
  }
  const parsed = proposalPayloadSchema.safeParse(row.payload);
  if (!parsed.success) {
    throw new Error(`Proposal ${row.id}: invalid payload — ${parsed.error.message}`);
  }
  if (parsed.data.kind !== row.kind) {
    throw new Error(
      `Proposal ${row.id}: row.kind='${row.kind}' but payload.kind='${parsed.data.kind}'`,
    );
  }
  return { ...parsed.data, id: row.id } as Proposal;
}
