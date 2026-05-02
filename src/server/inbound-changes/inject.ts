/**
 * Inbound-changes injector.
 *
 * When sync picks up a material change to an item AND the user has a live
 * conversation hanging off that item, drop a synthetic system message into
 * the transcript. The agent loop will see it on its next turn so it doesn't
 * keep reasoning over a stale ticket snapshot.
 *
 * Confirm flows write through `refreshCacheFromCanonical` in the executor,
 * not through `runSync`, so any change observed during sync is by
 * construction "external" — somebody else (or the same user via the
 * provider's UI) made it. That's exactly the signal we want to surface.
 *
 * Non-material changes (updatedAt drift, providerRaw bag fluctuation) are
 * filtered by the caller via `materialDiff`.
 */

import "server-only";
import { assertItemState, type Item as CanonicalItem, type ProjectId } from "@/core/types";
import type { Item as ItemRow } from "@/db/generated/client";
import { activeConversationsForItem } from "@/server/conversations/storage";
import type { db as Db } from "@/server/db";
import { logger } from "@/server/logger";

type Database = typeof Db;

export type MaterialChange = {
  field: "state" | "title" | "description" | "assignee";
  before: string;
  after: string;
};

/**
 * Compare a cached row against a freshly fetched canonical item. Only
 * fields a human reasoning about a ticket would care about count.
 */
export function materialDiff(
  cached: Pick<ItemRow, "state" | "title" | "description" | "assignee">,
  fresh: CanonicalItem,
): MaterialChange[] {
  const out: MaterialChange[] = [];
  if (cached.state !== fresh.state) {
    out.push({
      field: "state",
      before: assertItemState(cached.state, "cached Item.state"),
      after: fresh.state,
    });
  }
  if (cached.title !== fresh.title) {
    out.push({ field: "title", before: cached.title, after: fresh.title });
  }
  if (cached.description !== fresh.description) {
    out.push({
      field: "description",
      before: summarize(cached.description),
      after: summarize(fresh.description),
    });
  }
  if ((cached.assignee ?? "") !== (fresh.assignee ?? "")) {
    out.push({
      field: "assignee",
      before: cached.assignee ?? "(none)",
      after: fresh.assignee ?? "(none)",
    });
  }
  return out;
}

function summarize(md: string): string {
  const trimmed = md.trim();
  if (trimmed.length <= 200) return trimmed || "(empty)";
  return `${trimmed.slice(0, 200)}…`;
}

/**
 * Find every active conversation for `(projectId, itemId)` and append a
 * synthetic system message describing the change. No-op if there are no
 * active conversations.
 *
 * `itemId` here is the cached `Item.id` (cuid), not the providerItemId, so
 * the FK on `Conversation.itemId` matches.
 */
export async function injectExternalChange(
  db: Database,
  args: {
    projectId: ProjectId;
    itemId: string;
    providerItemId: string;
    changes: readonly MaterialChange[];
  },
): Promise<{ injectedInto: number }> {
  if (args.changes.length === 0) return { injectedInto: 0 };

  const conversations = await activeConversationsForItem(db, args.projectId, args.itemId);
  if (conversations.length === 0) return { injectedInto: 0 };

  const body = formatInboundChange(args.providerItemId, args.changes);
  // One batched insert instead of N parallel `INSERT` round-trips. A project
  // with 50 active conversations on a chatty item used to cost 50 separate
  // statements per material change; `createMany` collapses that to a single
  // multi-row insert.
  await db.message.createMany({
    data: conversations.map((conv) => ({
      conversationId: conv.id,
      role: "system" as const,
      content: body,
    })),
  });
  logger.debug(
    {
      projectId: args.projectId,
      itemId: args.itemId,
      providerItemId: args.providerItemId,
      conversations: conversations.length,
      fields: args.changes.map((c) => c.field),
    },
    "inbound-changes: injected into active conversations",
  );
  return { injectedInto: conversations.length };
}

function formatInboundChange(providerItemId: string, changes: readonly MaterialChange[]): string {
  const lines = [
    `Inbound change on ${providerItemId} (picked up via sync; not staged through this conversation):`,
  ];
  for (const c of changes) {
    if (c.field === "description") {
      lines.push(`  - description changed`);
      lines.push(`      before: ${c.before}`);
      lines.push(`      after: ${c.after}`);
    } else {
      lines.push(`  - ${c.field}: ${c.before} → ${c.after}`);
    }
  }
  return lines.join("\n");
}
