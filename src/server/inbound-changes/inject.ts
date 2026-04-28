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
import type { Item as CanonicalItem, ItemState } from "@/core/types";
import type { Item as ItemRow } from "@/db/generated/client";
import { activeConversationsForItem, appendMessage } from "@/server/conversations/storage";
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
  cached: Pick<ItemRow, "state" | "title" | "descriptionMd" | "assignee">,
  fresh: CanonicalItem,
): MaterialChange[] {
  const out: MaterialChange[] = [];
  if (cached.state !== fresh.state) {
    out.push({
      field: "state",
      before: cached.state as ItemState,
      after: fresh.state,
    });
  }
  if (cached.title !== fresh.title) {
    out.push({ field: "title", before: cached.title, after: fresh.title });
  }
  if (cached.descriptionMd !== fresh.descriptionMd) {
    out.push({
      field: "description",
      before: summarize(cached.descriptionMd),
      after: summarize(fresh.descriptionMd),
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
    projectId: string;
    itemId: string;
    providerItemId: string;
    changes: readonly MaterialChange[];
  },
): Promise<{ injectedInto: number }> {
  if (args.changes.length === 0) return { injectedInto: 0 };

  const conversations = await activeConversationsForItem(db, args.projectId, args.itemId);
  if (conversations.length === 0) return { injectedInto: 0 };

  const body = formatInboundChange(args.providerItemId, args.changes);
  // Each appendMessage is an independent insert against a different
  // Conversation row — fan out so a project with many active conversations
  // doesn't pay N round-trips serially during sync.
  await Promise.all(
    conversations.map((conv) =>
      appendMessage(db, {
        conversationId: conv.id,
        role: "system",
        content: body,
      }),
    ),
  );
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
