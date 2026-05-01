/**
 * Proposal executor — the ONE place provider write methods are called.
 *
 * The arch test `src/__arch__/no-provider-write-leak.test.ts` enforces
 * this rule by regex-scanning the source tree and asserting that no
 * file outside this module (or the GitHub provider implementation
 * itself) calls `.transition(`, `.patchDescription(`, `.uploadAttachment(`,
 * `.addComment(`, or `.createItem(`. That keeps the proposal-first
 * mutation invariant load-bearing.
 *
 * `confirmProposal` runs the four-step write protocol:
 *   1. Load + validate the pending proposal
 *   2. Build the per-user provider via the registry
 *   3. Call the matching write method on the provider
 *   4. Refresh the cached `Item` row from the response, stamp
 *      `confirmedAt` / `executedAt`, return the updated proposal row
 *
 * On failure, the proposal is reverted to `pending` with `errorMessage`
 * set so the user can inspect what happened and retry from the same UI.
 * `errorMessage` is cleared on the next optimistic flip, so a successful
 * retry leaves no stale error behind.
 */

import "server-only";
import { TRPCError } from "@trpc/server";
import {
  asProposalId,
  type Item as CanonicalItem,
  type ProjectId,
  type ProposalId,
  type UserId,
} from "@/core/types";
import { Prisma, type Proposal as ProposalRow } from "@/db/generated/client";
import type { db as Db } from "@/server/db";
import { assertFound } from "@/server/errors";
import { errFields } from "@/server/log-fields";
import { logger } from "@/server/logger";
import { buildDuplicateCommentBody, hydrateProposal } from "@/server/proposals/builders";
import { buildProviderForUser } from "@/server/providers/build";
import {
  AUTO_ACCEPT_EXTRA_ELIGIBLE_KINDS_LIST,
  AUTO_ACCEPT_FLOOR_KINDS_LIST,
} from "@/server/settings/catalog";
import { loadGlobalSetting, loadProjectSetting } from "@/server/settings/effective";
import { reconcileComments, toItemRow } from "@/server/sync";

type ConfirmPhase = "load" | "provider_build" | "provider_call" | "cache_refresh" | "audit";

type ExecutorContext = {
  db: typeof Db;
  projectId: ProjectId;
  userId: UserId;
};

/**
 * Audit retention prune. Lives here (not in the settings router) because
 * `db.audit.<write>` is locked to this module by `no-audit-write-leak.test.ts`
 * — every audit row write/delete site must be auditable in one place.
 */
export async function pruneAuditOlderThan(
  db: typeof import("@/server/db").db,
  cutoff: Date,
): Promise<number> {
  const res = await db.audit.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return res.count;
}

async function recordAudit(
  ctx: ExecutorContext,
  action: string,
  proposalId: ProposalId,
  payload: Prisma.InputJsonValue,
): Promise<void> {
  // Best-effort: never let audit failures swallow the user-visible result.
  try {
    await ctx.db.audit.create({
      data: {
        projectId: ctx.projectId,
        userId: ctx.userId,
        action,
        proposalId,
        payload,
      },
    });
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
  }
}

async function loadPending(ctx: ExecutorContext, proposalId: ProposalId) {
  const row = assertFound(
    await ctx.db.proposal.findFirst({
      where: { id: proposalId, projectId: ctx.projectId },
    }),
    "proposal not found",
  );
  if (row.status !== "pending") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `proposal is in '${row.status}' state; only 'pending' can be confirmed or rejected`,
    });
  }
  return row;
}

async function refreshCacheFromCanonical(
  ctx: ExecutorContext,
  canonical: CanonicalItem,
): Promise<void> {
  const row = toItemRow(canonical, ctx.projectId, new Date());
  await ctx.db.item.upsert({
    where: {
      projectId_providerItemId: {
        projectId: ctx.projectId,
        providerItemId: canonical.id,
      },
    },
    create: row,
    update: { ...row, archived: false },
  });
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
    await ctx.db.project.findUnique({ where: { id: ctx.projectId } }),
    "project not found",
  );

  const confirmedAt = new Date();
  // Optimistic flip locks out concurrent confirms while the provider call is
  // in flight. We also clear `errorMessage` so a retry after a transient
  // provider failure doesn't carry the previous attempt's error forward
  // after succeeding.
  await ctx.db.proposal.update({
    where: { id: row.id },
    data: { status: "confirmed", confirmedAt, errorMessage: null },
  });

  try {
    const provider = await buildProviderForUser(ctx.db, project, ctx.userId);
    let canonical: CanonicalItem | null = null;
    let commentId: string | null = null;
    phase = "provider_call";
    const providerStartedAt = Date.now();

    switch (proposal.kind) {
      case "state_change": {
        // close_duplicate bundles a comment naming the canonical item with the
        // transition itself. Comment goes first so the duplicate-link is
        // durable even if the transition fails (a retry won't double-post —
        // we stamp `postedCommentId` on the proposal payload between the two
        // calls; on retry we skip the addComment step).
        if (proposal.intent === "close_duplicate" && proposal.canonicalItem) {
          if (!proposal.postedCommentId) {
            const body = buildDuplicateCommentBody(proposal.canonicalItem);
            const comment = await provider.addComment(proposal.item.id, body);
            commentId = comment.id;
            const cachedItem = await ctx.db.item.findUnique({
              where: {
                projectId_providerItemId: {
                  projectId: ctx.projectId,
                  providerItemId: proposal.item.id,
                },
              },
              select: { id: true },
            });
            if (cachedItem) {
              await reconcileComments(ctx.db, [
                { itemSurrogate: cachedItem.id, comments: [comment] },
              ]);
            }
            // Persist the posted comment id back into the payload so a later
            // retry (after a transition failure) can skip re-posting. Mutate
            // by merging onto the existing payload object — Prisma's JSON
            // column accepts a full replacement value, so we hand it the
            // updated proposal minus the surrogate id.
            const { id: _ignore, ...rest } = proposal;
            const nextPayload = { ...rest, postedCommentId: comment.id };
            await ctx.db.proposal.update({
              where: { id: row.id },
              data: { payload: nextPayload as unknown as Prisma.InputJsonValue },
            });
            proposal.postedCommentId = comment.id;
          } else {
            commentId = proposal.postedCommentId;
          }
        }
        canonical = await provider.transition(proposal.item.id, proposal.intent);
        break;
      }
      case "description_patch":
        canonical = await provider.patchDescription(proposal.item.id, proposal.newDescription);
        break;
      case "comment_add": {
        const comment = await provider.addComment(proposal.item.id, proposal.body);
        commentId = comment.id;
        const cachedItem = await ctx.db.item.findUnique({
          where: {
            projectId_providerItemId: {
              projectId: ctx.projectId,
              providerItemId: proposal.item.id,
            },
          },
          select: { id: true },
        });
        if (cachedItem) {
          await reconcileComments(ctx.db, [{ itemSurrogate: cachedItem.id, comments: [comment] }]);
        }
        break;
      }
      case "item_create":
        canonical = await provider.createItem(proposal.itemKind, proposal.fields);
        break;
      case "tags_change":
        canonical = await provider.setTags(proposal.item.id, proposal.nextTags);
        break;
      case "assignee_change":
        canonical = await provider.setAssignee(proposal.item.id, proposal.nextAssignee);
        break;
      case "reaction_toggle": {
        const fn = proposal.op === "add" ? provider.addReaction : provider.removeReaction;
        if (!fn) {
          throw new Error(
            `provider does not support reactions (op='${proposal.op}'); check capabilities.supportedReactions before staging`,
          );
        }
        const target = { kind: proposal.targetKind, id: proposal.targetId } as const;
        const result = await fn.call(provider, target, proposal.reaction);
        const reactionsJson = (result.reactions ?? Prisma.JsonNull) as
          | Prisma.InputJsonValue
          | typeof Prisma.JsonNull;
        if (proposal.targetKind === "item") {
          await ctx.db.item.update({
            where: {
              projectId_providerItemId: {
                projectId: ctx.projectId,
                providerItemId: proposal.item.id,
              },
            },
            data: { reactions: reactionsJson },
          });
        } else {
          const cachedItem = await ctx.db.item.findUnique({
            where: {
              projectId_providerItemId: {
                projectId: ctx.projectId,
                providerItemId: proposal.item.id,
              },
            },
            select: { id: true },
          });
          if (cachedItem) {
            await ctx.db.comment.updateMany({
              where: { itemId: cachedItem.id, providerCommentId: proposal.targetId },
              data: { reactions: reactionsJson },
            });
          }
        }
        break;
      }
      case "attachment_upload":
        await provider.uploadAttachment(
          proposal.item.id,
          proposal.filename,
          proposal.content,
          proposal.contentType,
        );
        break;
      case "memory_write":
        if (proposal.memoryId) {
          await ctx.db.memoryEntry.update({
            where: { id: proposal.memoryId },
            data: {
              title: proposal.title,
              body: proposal.body,
              tags: [...proposal.tags],
              source: proposal.source,
            },
          });
        } else {
          await ctx.db.memoryEntry.create({
            data: {
              projectId: ctx.projectId,
              title: proposal.title,
              body: proposal.body,
              tags: [...proposal.tags],
              source: proposal.source,
            },
          });
        }
        break;
      case "memory_delete":
        await ctx.db.memoryEntry.deleteMany({
          where: { id: proposal.memoryId, projectId: ctx.projectId },
        });
        break;
      default: {
        const exhaustive: never = proposal;
        throw new Error(`Unhandled proposal kind: ${(exhaustive as { kind: string }).kind}`);
      }
    }

    const providerMs = Date.now() - providerStartedAt;

    if (canonical) {
      phase = "cache_refresh";
      await refreshCacheFromCanonical(ctx, canonical);
    }

    phase = "audit";
    const updated = await ctx.db.proposal.update({
      where: { id: row.id },
      data: {
        executedAt: new Date(),
        ...(commentId && proposal.kind === "comment_add"
          ? { providerItemId: proposal.item.id }
          : {}),
      },
    });
    await recordAudit(ctx, okAction, asProposalId(row.id), {
      kind: row.kind,
      providerItemId: row.providerItemId,
      ...(commentId ? { commentId } : {}),
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
    // Revert status to `pending` so the user can retry from the same UI —
    // `loadPending` only accepts pending rows, so leaving status at
    // `confirmed` here would have permanently locked the proposal out.
    const failed = await ctx.db.proposal.update({
      where: { id: row.id },
      data: { status: "pending", confirmedAt: null, errorMessage: message },
    });
    await recordAudit(ctx, failAction, asProposalId(row.id), {
      kind: row.kind,
      providerItemId: row.providerItemId,
      error: message,
    });
    logger.error(
      {
        ...baseCtx,
        action: failAction,
        phase,
        durationMs: Date.now() - startedAt,
        ...errFields(err),
      },
      "proposals: confirm failed",
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
  const isFloor = AUTO_ACCEPT_FLOOR_KINDS_LIST.includes(row.kind);
  const isExtraEligible = AUTO_ACCEPT_EXTRA_ELIGIBLE_KINDS_LIST.includes(row.kind);
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
  return confirmProposal(ctx, asProposalId(row.id), { source: "auto" });
}

export async function rejectProposal(
  ctx: ExecutorContext,
  proposalId: ProposalId,
): Promise<ProposalRow> {
  const row = await loadPending(ctx, proposalId);
  const updated = await ctx.db.proposal.update({
    where: { id: row.id },
    data: { status: "rejected" },
  });
  await recordAudit(ctx, "proposal.reject", asProposalId(row.id), {
    kind: row.kind,
    providerItemId: row.providerItemId,
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
