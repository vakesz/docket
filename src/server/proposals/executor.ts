// The ONE place provider write methods are called. Enforced by the regex
// scan in `src/__arch__/no-provider-write-leak.test.ts` — every other
// caller of `.transition(` / `.patchDescription(` / `.addComment(` /
// `.createItem(` / `.setTags(` etc. is a leak of the proposal-first
// invariant. Failed writes flip the proposal back to `pending` with
// `errorMessage`; the next optimistic flip clears it so a successful
// retry leaves no stale error.

import "server-only";
import { TRPCError } from "@trpc/server";
import { and, eq, lt } from "drizzle-orm";
import type { Proposal } from "@/core/proposal-types";
import type { WorkItemProvider } from "@/core/provider";
import type {
  Comment as CanonicalComment,
  Item as CanonicalItem,
  ItemId,
  ProjectId,
  ProposalId,
  ProviderItemId,
  Reactions,
  UserId,
} from "@/core/types";
import type { Db } from "@/db";
import { audits, comments, items, memoryEntries, projects, proposals } from "@/db/schema";
import type { Proposal as ProposalRow } from "@/db/schema/types";
import { assertFound } from "@/server/errors";
import { errFields } from "@/server/log-fields";
import { logger } from "@/server/logger";
import { buildDuplicateCommentBody, hydrateProposal } from "@/server/proposals/builders";
import { toJsonProposalPayload } from "@/server/proposals/schema";
import { buildProviderForUser } from "@/server/providers/build";
import {
  AUTO_ACCEPT_EXTRA_ELIGIBLE_KINDS,
  AUTO_ACCEPT_FLOOR_KINDS,
  isAutoAcceptKind,
} from "@/server/settings/catalog";
import { loadGlobalSetting, loadProjectSetting } from "@/server/settings/effective";
import { reconcileComments, toItemRow } from "@/server/sync";

type ConfirmPhase = "load" | "provider_build" | "provider_call" | "finalize";

type ReactionUpdate =
  | {
      kind: "item";
      providerItemId: ProviderItemId;
      reactions: Reactions | null;
    }
  | {
      kind: "comment";
      itemSurrogate: ItemId;
      providerCommentId: string;
      reactions: Reactions | null;
    };

type ExecutorContext = {
  db: Db;
  projectId: ProjectId;
  userId: UserId;
};

/**
 * Audit retention prune. Lives here (not in the settings router) because
 * `audit.<write>` is locked to this module by `no-audit-write-leak.test.ts`
 * — every audit row write/delete site must be auditable in one place.
 */
export async function pruneAuditOlderThan(db: Db, cutoff: Date): Promise<number> {
  const deleted = await db
    .delete(audits)
    .where(lt(audits.createdAt, cutoff))
    .returning({ id: audits.id });
  return deleted.length;
}

type AuditWriteResult = { ok: true } | { ok: false; error: string };

async function recordFailureAudit(
  ctx: ExecutorContext,
  action: string,
  proposalId: ProposalId,
  payload: Record<string, unknown>,
): Promise<AuditWriteResult> {
  // Best-effort: failure audits run in the catch block; the DB may already be
  // sick. Don't let an audit miss swallow the user-visible result. Success
  // audits go through the finalize transaction below where they're atomic
  // with executedAt. Returns the outcome so the caller can stamp the
  // proposal's errorMessage with a degraded-audit note instead of leaving
  // the failure invisible to the UI.
  try {
    await ctx.db.insert(audits).values({
      projectId: ctx.projectId,
      userId: ctx.userId,
      action,
      proposalId,
      payload,
    });
    return { ok: true };
  } catch (err) {
    logger.error(
      {
        projectId: ctx.projectId,
        userId: ctx.userId,
        action,
        proposalId,
        ...errFields(err),
      },
      "proposals: audit write failed",
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function loadPending(ctx: ExecutorContext, proposalId: ProposalId): Promise<ProposalRow> {
  const row = assertFound(
    await ctx.db.query.proposals.findFirst({ where: eq(proposals.id, proposalId) }),
    "proposal not found",
  );
  if (row.projectId !== ctx.projectId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "proposal not found" });
  }
  if (row.status !== "pending") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `proposal is in '${row.status}' state; only 'pending' can be confirmed or rejected`,
    });
  }
  return row;
}

export type ConfirmSource = "user" | "auto";

export async function confirmProposal(
  ctx: ExecutorContext,
  proposalId: ProposalId,
  options: { source?: ConfirmSource } = {},
): Promise<ProposalRow> {
  const source: ConfirmSource = options.source ?? "user";
  const okAction = source === "auto" ? "proposal.auto_confirm" : "proposal.confirm";
  const failAction = source === "auto" ? "proposal.auto_confirm.failed" : "proposal.confirm.failed";
  const startedAt = Date.now();
  let phase: ConfirmPhase = "load";

  const row = await loadPending(ctx, proposalId);
  // Defense in depth: agent-origin rows must never reach the provider via
  // the auto-confirm path. `maybeAutoAccept` already filters them, but a
  // future caller could call confirmProposal directly with source="auto" —
  // refuse loudly so we notice in tests instead of silently approving.
  if (source === "auto" && row.origin !== "ui") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `auto-confirm is only allowed for ui-originated proposals (got origin='${row.origin}')`,
    });
  }
  const proposal = hydrateProposal(row);

  const baseCtx = {
    projectId: ctx.projectId,
    userId: ctx.userId,
    proposalId,
    kind: row.kind,
    providerItemId: row.providerItemId ?? null,
    source,
  };
  logger.info(baseCtx, "proposals: confirm start");

  phase = "provider_build";
  const project = assertFound(
    await ctx.db.query.projects.findFirst({
      where: eq(projects.id, ctx.projectId),
      columns: {
        id: true,
        providerKind: true,
        providerScope: true,
        name: true,
      },
    }),
    "project not found",
  );

  const confirmedAt = new Date();
  // Optimistic flip locks out concurrent confirms while the provider call is
  // in flight. We also clear `errorMessage` so a retry after a transient
  // provider failure doesn't carry the previous attempt's error forward
  // after succeeding.
  await ctx.db
    .update(proposals)
    .set({ status: "confirmed", confirmedAt, errorMessage: null })
    .where(eq(proposals.id, row.id));

  // Outcome of the provider call(s) — captured during phase 1, applied by
  // the finalize transaction in phase 2. Memory ops have no provider call;
  // their work runs entirely in the finalize tx.
  let canonical: CanonicalItem | null = null;
  let commentId: string | null = null;
  let postedComment: { itemSurrogate: ItemId; comment: CanonicalComment } | null = null;
  let reactionUpdate: ReactionUpdate | null = null;
  let providerMs = 0;

  try {
    // ─── Phase 1: provider call ──────────────────────────────────────────
    // No persistent local DB writes here. Failure is recoverable: the catch
    // block reverts the optimistic flip so the user can retry. The one
    // exception is close_duplicate's bundled comment, which posts BEFORE the
    // transition and persists `postedCommentId` so a retry skips re-posting.
    const provider = await buildProviderForUser(ctx.db, project, ctx.userId);
    phase = "provider_call";
    const providerStartedAt = Date.now();

    const outcome = await dispatchProviderCall(ctx, provider, proposal, row.id);
    canonical = outcome.canonical ?? null;
    commentId = outcome.commentId ?? null;
    postedComment = outcome.postedComment ?? null;
    reactionUpdate = outcome.reactionUpdate ?? null;

    providerMs = Date.now() - providerStartedAt;

    // ─── Phase 2: finalize ───────────────────────────────────────────────
    // Atomic: apply cache writes, run memory ops, stamp executedAt, insert
    // audit. Either all succeed or none commit. Failure here is split into
    // two cases by the catch block:
    //   - memory_write/memory_delete: provider equivalent IS the DB write,
    //     which rolls back with the tx → safe to revert to pending.
    //   - everything else: provider write already succeeded; rolling back
    //     would risk double-execution on retry → keep status=confirmed and
    //     stamp errorMessage so the UI surfaces the partial state.
    phase = "finalize";
    const updated = await ctx.db.transaction(async (tx) => {
      if (canonical) {
        const itemRow = toItemRow(canonical, ctx.projectId, new Date());
        await tx
          .insert(items)
          .values(itemRow)
          .onConflictDoUpdate({
            target: [items.projectId, items.providerItemId],
            set: { ...itemRow, archived: false },
          });
      }
      if (postedComment) {
        await reconcileComments(tx, [
          { itemSurrogate: postedComment.itemSurrogate, comments: [postedComment.comment] },
        ]);
      }
      if (reactionUpdate?.kind === "item") {
        await tx
          .update(items)
          .set({ reactions: reactionUpdate.reactions })
          .where(
            and(
              eq(items.projectId, ctx.projectId),
              eq(items.providerItemId, reactionUpdate.providerItemId),
            ),
          );
      } else if (reactionUpdate?.kind === "comment") {
        await tx
          .update(comments)
          .set({ reactions: reactionUpdate.reactions })
          .where(
            and(
              eq(comments.itemId, reactionUpdate.itemSurrogate),
              eq(comments.providerCommentId, reactionUpdate.providerCommentId),
            ),
          );
      }
      if (proposal.kind === "memory_write") {
        if (proposal.memoryId) {
          await tx
            .update(memoryEntries)
            .set({
              title: proposal.title,
              body: proposal.body,
              tags: [...proposal.tags],
              source: proposal.source,
            })
            .where(eq(memoryEntries.id, proposal.memoryId));
        } else {
          await tx.insert(memoryEntries).values({
            projectId: ctx.projectId,
            title: proposal.title,
            body: proposal.body,
            tags: [...proposal.tags],
            source: proposal.source,
          });
        }
      } else if (proposal.kind === "memory_delete") {
        await tx
          .delete(memoryEntries)
          .where(
            and(
              eq(memoryEntries.id, proposal.memoryId),
              eq(memoryEntries.projectId, ctx.projectId),
            ),
          );
      }
      const [updatedRow] = await tx
        .update(proposals)
        .set({
          executedAt: new Date(),
          ...(commentId && proposal.kind === "comment_add"
            ? { providerItemId: proposal.item.id }
            : {}),
        })
        .where(eq(proposals.id, row.id))
        .returning();
      if (!updatedRow) throw new Error("confirmProposal: finalize update returned no row");
      await tx.insert(audits).values({
        projectId: ctx.projectId,
        userId: ctx.userId,
        action: okAction,
        proposalId: row.id,
        payload: {
          kind: row.kind,
          providerItemId: row.providerItemId,
          ...(commentId ? { commentId } : {}),
        },
      });
      return updatedRow;
    });

    logger.info(
      {
        ...baseCtx,
        action: okAction,
        providerMs,
        durationMs: Date.now() - startedAt,
        ...(commentId ? { commentId } : {}),
      },
      "proposals: confirm done",
    );
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isMemoryKind = proposal.kind === "memory_write" || proposal.kind === "memory_delete";
    // Failure split: provider already wrote vs. rollback was clean.
    //   - phase ≤ "provider_call" or memory kind: provider side-effect did
    //     not happen (or rolled back with the tx). Revert to pending so the
    //     user can retry.
    //   - phase = "finalize" on a non-memory kind: provider already wrote.
    //     Reverting would risk double-execution on retry. Keep status at
    //     confirmed and stamp errorMessage so the UI shows the partial state.
    const stuck = phase === "finalize" && !isMemoryKind;
    const [failed] = stuck
      ? await ctx.db
          .update(proposals)
          .set({
            errorMessage: `provider write succeeded but local sync failed: ${message}`,
          })
          .where(eq(proposals.id, row.id))
          .returning()
      : await ctx.db
          .update(proposals)
          .set({ status: "pending", confirmedAt: null, errorMessage: message })
          .where(eq(proposals.id, row.id))
          .returning();
    if (!failed) throw new Error("confirmProposal: failure update returned no row");
    const auditWrite = await recordFailureAudit(ctx, failAction, row.id, {
      kind: row.kind,
      providerItemId: row.providerItemId,
      error: message,
      ...(stuck ? { stuck: true } : {}),
    });
    if (!auditWrite.ok) {
      // The failure audit itself failed — surface it on the row so the UI
      // shows the user the audit trail is incomplete for this proposal,
      // instead of letting the miss disappear into the logs.
      const note = `${failed.errorMessage ?? message} [audit write also failed: ${auditWrite.error}]`;
      await ctx.db.update(proposals).set({ errorMessage: note }).where(eq(proposals.id, row.id));
      failed.errorMessage = note;
    }
    logger.error(
      {
        ...baseCtx,
        action: failAction,
        phase,
        durationMs: Date.now() - startedAt,
        ...errFields(err),
      },
      stuck
        ? "proposals: provider write succeeded but local finalize failed — proposal stuck"
        : "proposals: confirm failed",
    );
    return failed;
  }
}

/**
 * Bridge from "proposal staged" to "proposal applied" when a UI-origin row
 * qualifies for auto-confirm. Two paths:
 *   - Floor: comment_add and reaction_toggle always auto-confirm from the
 *     UI. The architecture promise — typing a comment in the frontend lands
 *     directly — is unconditional, not policy-gated.
 *   - Extras: kinds the project opted into via `proposals.auto-accept-extra-kinds`
 *     (memory writes/deletes only — provider-touching kinds aren't eligible).
 *
 * Read-only mode wins on both paths: the row stays pending so the human can
 * inspect it once the freeze lifts.
 *
 * Returns the row in its terminal state: still pending if not eligible /
 * read-only, otherwise the post-confirmProposal row.
 *
 * Defense in depth:
 *   - Origin gate: agent-staged rows never auto-confirm. Only origin === "ui"
 *     reaches either path.
 *   - The catalog validator already restricts the extras list to Tier-A
 *     local-DB kinds, but the eligible-list gate here is load-bearing — if a
 *     stored row ever drifts to an ineligible kind we simply ignore it.
 */
export async function maybeAutoAccept(
  ctx: ExecutorContext,
  row: ProposalRow,
): Promise<ProposalRow> {
  if (row.status !== "pending") return row;
  if (row.origin !== "ui") return row;
  const isFloor = isAutoAcceptKind(row.kind, AUTO_ACCEPT_FLOOR_KINDS);
  const isExtraEligible = isAutoAcceptKind(row.kind, AUTO_ACCEPT_EXTRA_ELIGIBLE_KINDS);
  if (!isFloor && !isExtraEligible) return row;
  const readOnly = await loadGlobalSetting(ctx.db, "app.read-only");
  if (readOnly) return row;
  if (!isFloor) {
    const extras = await loadProjectSetting(
      ctx.db,
      ctx.projectId,
      "proposals.auto-accept-extra-kinds",
    );
    if (!(extras as readonly string[]).includes(row.kind)) return row;
  }
  return confirmProposal(ctx, row.id, { source: "auto" });
}

export async function rejectProposal(
  ctx: ExecutorContext,
  proposalId: ProposalId,
): Promise<ProposalRow> {
  const row = await loadPending(ctx, proposalId);
  // Atomic with the audit row so reject + trail commit together.
  const updated = await ctx.db.transaction(async (tx) => {
    const [r] = await tx
      .update(proposals)
      .set({ status: "rejected" })
      .where(eq(proposals.id, row.id))
      .returning();
    if (!r) throw new Error("rejectProposal: update returned no row");
    await tx.insert(audits).values({
      projectId: ctx.projectId,
      userId: ctx.userId,
      action: "proposal.reject",
      proposalId: row.id,
      payload: {
        kind: row.kind,
        providerItemId: row.providerItemId,
      },
    });
    return r;
  });
  logger.info(
    {
      projectId: ctx.projectId,
      userId: ctx.userId,
      proposalId,
      kind: row.kind,
      providerItemId: row.providerItemId ?? null,
    },
    "proposals: rejected",
  );
  return updated;
}

// ---------------------------------------------------------------------------
// Phase 1 dispatch — one helper per kind, called from confirmProposal above.
// Each helper is responsible for the provider write and any pre-write
// bookkeeping (e.g. close_duplicate's bundled comment). The combined outcome
// is captured here and applied by phase 2's finalize transaction.
// ---------------------------------------------------------------------------

type ProviderCallOutcome = {
  canonical?: CanonicalItem;
  commentId?: string;
  postedComment?: { itemSurrogate: ItemId; comment: CanonicalComment };
  reactionUpdate?: ReactionUpdate;
};

async function dispatchProviderCall(
  ctx: ExecutorContext,
  provider: WorkItemProvider,
  proposal: Proposal,
  rowId: ProposalId,
): Promise<ProviderCallOutcome> {
  switch (proposal.kind) {
    case "state_change":
      return await dispatchStateChange(ctx, provider, proposal, rowId);
    case "description_patch":
      return {
        canonical: await provider.patchDescription(proposal.item.id, proposal.newDescription),
      };
    case "comment_add":
      return await dispatchCommentAdd(ctx, provider, proposal);
    case "item_create":
      return { canonical: await provider.createItem(proposal.itemKind, proposal.fields) };
    case "tags_change":
      return { canonical: await provider.setTags(proposal.item.id, proposal.nextTags) };
    case "assignee_change":
      return { canonical: await provider.setAssignee(proposal.item.id, proposal.nextAssignee) };
    case "reaction_toggle":
      return await dispatchReactionToggle(ctx, provider, proposal);
    case "attachment_upload":
      await provider.uploadAttachment(
        proposal.item.id,
        proposal.filename,
        proposal.content,
        proposal.contentType,
      );
      return {};
    case "memory_write":
    case "memory_delete":
      // Memory ops are local-only — their work runs in the finalize tx so
      // it's atomic with executedAt + audit.
      return {};
    default: {
      const exhaustive: never = proposal;
      throw new Error(`Unhandled proposal kind: ${(exhaustive as { kind: string }).kind}`);
    }
  }
}

async function dispatchStateChange(
  ctx: ExecutorContext,
  provider: WorkItemProvider,
  proposal: Extract<Proposal, { kind: "state_change" }>,
  rowId: ProposalId,
): Promise<ProviderCallOutcome> {
  let commentId: string | undefined;
  if (proposal.intent === "close_duplicate" && proposal.canonicalItem) {
    if (!proposal.postedCommentId) {
      const body = buildDuplicateCommentBody(proposal.canonicalItem);
      const comment = await provider.addComment(proposal.item.id, body);
      commentId = comment.id;
      const cachedItem = await ctx.db.query.items.findFirst({
        where: and(eq(items.projectId, ctx.projectId), eq(items.providerItemId, proposal.item.id)),
        columns: { id: true },
      });
      // Atomic: reconcile the cached comment AND stamp postedCommentId
      // before the transition call. A retry after transition failure
      // sees postedCommentId and skips re-posting.
      const { id: _, ...rest } = proposal;
      const nextPayload = { ...rest, postedCommentId: comment.id };
      await ctx.db.transaction(async (tx) => {
        if (cachedItem) {
          await reconcileComments(tx, [{ itemSurrogate: cachedItem.id, comments: [comment] }]);
        }
        await tx
          .update(proposals)
          .set({ payload: toJsonProposalPayload(nextPayload) })
          .where(eq(proposals.id, rowId));
      });
      proposal.postedCommentId = comment.id;
    } else {
      commentId = proposal.postedCommentId;
    }
  }
  const canonical = await provider.transition(proposal.item.id, proposal.intent);
  return commentId !== undefined ? { canonical, commentId } : { canonical };
}

async function dispatchCommentAdd(
  ctx: ExecutorContext,
  provider: WorkItemProvider,
  proposal: Extract<Proposal, { kind: "comment_add" }>,
): Promise<ProviderCallOutcome> {
  const comment = await provider.addComment(proposal.item.id, proposal.body);
  const cachedItem = await ctx.db.query.items.findFirst({
    where: and(eq(items.projectId, ctx.projectId), eq(items.providerItemId, proposal.item.id)),
    columns: { id: true },
  });
  return cachedItem
    ? { commentId: comment.id, postedComment: { itemSurrogate: cachedItem.id, comment } }
    : { commentId: comment.id };
}

async function dispatchReactionToggle(
  ctx: ExecutorContext,
  provider: WorkItemProvider,
  proposal: Extract<Proposal, { kind: "reaction_toggle" }>,
): Promise<ProviderCallOutcome> {
  const fn = proposal.op === "add" ? provider.addReaction : provider.removeReaction;
  if (!fn) {
    throw new Error(
      `provider does not support reactions (op='${proposal.op}'); check capabilities.supportedReactions before staging`,
    );
  }
  const target = { kind: proposal.targetKind, id: proposal.targetId } as const;
  const result = await fn.call(provider, target, proposal.reaction);
  const reactionsJson: Reactions | null = result.reactions ?? null;
  if (proposal.targetKind === "item") {
    return {
      reactionUpdate: {
        kind: "item",
        providerItemId: proposal.item.id,
        reactions: reactionsJson,
      },
    };
  }
  const cachedItem = await ctx.db.query.items.findFirst({
    where: and(eq(items.projectId, ctx.projectId), eq(items.providerItemId, proposal.item.id)),
    columns: { id: true },
  });
  if (!cachedItem) return {};
  return {
    reactionUpdate: {
      kind: "comment",
      itemSurrogate: cachedItem.id,
      providerCommentId: proposal.targetId,
      reactions: reactionsJson,
    },
  };
}
