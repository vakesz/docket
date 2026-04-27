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
 * On failure, the proposal stays in `confirmed` state with `errorMessage`
 * set so the user can inspect what happened and retry.
 */

import "server-only";
import { TRPCError } from "@trpc/server";
import type { Item as CanonicalItem } from "@/core/types";
import type { Prisma, Proposal as ProposalRow } from "@/db/generated/client";
import type { db as Db } from "@/server/db";
import { hydrateProposal } from "@/server/proposals/builders";
import { buildProviderForUser } from "@/server/providers/build";

type ExecutorContext = {
  db: typeof Db;
  projectId: string;
  userId: string;
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
  proposalId: string,
  payload: Prisma.InputJsonValue,
): Promise<void> {
  // Best-effort: never let audit failures swallow the user-visible result.
  // We log via console so the surface still gets the original outcome.
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
    console.error("audit.write failed", { action, proposalId, err });
  }
}

async function loadPending(ctx: ExecutorContext, proposalId: string) {
  const row = await ctx.db.proposal.findFirst({
    where: { id: proposalId, projectId: ctx.projectId },
  });
  if (!row) {
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

async function refreshCacheFromCanonical(
  ctx: ExecutorContext,
  canonical: CanonicalItem,
): Promise<void> {
  const data = {
    projectId: ctx.projectId,
    providerItemId: canonical.id,
    kind: canonical.kind,
    title: canonical.title,
    descriptionMd: canonical.descriptionMd,
    state: canonical.state,
    assignee: canonical.assignee,
    author: canonical.author,
    parentId: canonical.parentId,
    tags: canonical.tags,
    providerRaw: canonical.providerRaw as Prisma.InputJsonValue,
    url: canonical.url,
    repositoryUrl: canonical.repositoryUrl,
    createdAt: canonical.createdAt,
    updatedAt: canonical.updatedAt ?? new Date(),
    syncedAt: new Date(),
    archived: false,
  };
  await ctx.db.item.upsert({
    where: {
      projectId_providerItemId: {
        projectId: ctx.projectId,
        providerItemId: canonical.id,
      },
    },
    create: data,
    update: data,
  });
}

export async function confirmProposal(
  ctx: ExecutorContext,
  proposalId: string,
): Promise<ProposalRow> {
  const row = await loadPending(ctx, proposalId);
  const proposal = hydrateProposal(row);

  const project = await ctx.db.project.findUnique({
    where: { id: ctx.projectId },
  });
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "project not found" });
  }

  const confirmedAt = new Date();
  await ctx.db.proposal.update({
    where: { id: row.id },
    data: { status: "confirmed", confirmedAt },
  });

  try {
    const provider = await buildProviderForUser(ctx.db, project, ctx.userId);
    let canonical: CanonicalItem | null = null;
    let commentId: string | null = null;

    switch (proposal.kind) {
      case "state_change":
        canonical = await provider.transition(proposal.item.id, proposal.intent);
        break;
      case "description_patch":
        canonical = await provider.patchDescription(proposal.item.id, proposal.newMd);
        break;
      case "comment_add": {
        const comment = await provider.addComment(proposal.item.id, proposal.bodyMd);
        commentId = comment.id;
        // Refresh the cached comment row alongside the item.
        const cachedItem = await ctx.db.item.findFirst({
          where: { projectId: ctx.projectId, providerItemId: proposal.item.id },
        });
        if (cachedItem) {
          await ctx.db.comment.upsert({
            where: {
              itemId_providerCommentId: {
                itemId: cachedItem.id,
                providerCommentId: comment.id,
              },
            },
            create: {
              itemId: cachedItem.id,
              providerCommentId: comment.id,
              author: comment.author,
              bodyMd: comment.bodyMd,
              createdAt: comment.createdAt,
            },
            update: {
              author: comment.author,
              bodyMd: comment.bodyMd,
              createdAt: comment.createdAt,
            },
          });
        }
        break;
      }
      case "item_create":
        canonical = await provider.createItem(proposal.itemKind, proposal.fields);
        break;
      case "tags_change":
        canonical = await provider.setTags(proposal.item.id, proposal.nextTags);
        break;
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
              bodyMd: proposal.bodyMd,
              tags: [...proposal.tags],
              source: proposal.source,
            },
          });
        } else {
          await ctx.db.memoryEntry.create({
            data: {
              projectId: ctx.projectId,
              title: proposal.title,
              bodyMd: proposal.bodyMd,
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

    if (canonical) {
      await refreshCacheFromCanonical(ctx, canonical);
    }

    const updated = await ctx.db.proposal.update({
      where: { id: row.id },
      data: {
        executedAt: new Date(),
        ...(commentId
          ? { providerItemId: proposal.kind === "comment_add" ? proposal.item.id : null }
          : {}),
      },
    });
    await recordAudit(ctx, "proposal.confirm", row.id, {
      kind: row.kind,
      providerItemId: row.providerItemId,
      ...(commentId ? { commentId } : {}),
    });
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = await ctx.db.proposal.update({
      where: { id: row.id },
      data: { errorMessage: message },
    });
    await recordAudit(ctx, "proposal.confirm.failed", row.id, {
      kind: row.kind,
      providerItemId: row.providerItemId,
      error: message,
    });
    return failed;
  }
}

export async function rejectProposal(
  ctx: ExecutorContext,
  proposalId: string,
): Promise<ProposalRow> {
  const row = await loadPending(ctx, proposalId);
  const updated = await ctx.db.proposal.update({
    where: { id: row.id },
    data: { status: "rejected" },
  });
  await recordAudit(ctx, "proposal.reject", row.id, {
    kind: row.kind,
    providerItemId: row.providerItemId,
  });
  return updated;
}
