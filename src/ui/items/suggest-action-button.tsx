"use client";

import { Sparkles } from "lucide-react";
import type { ItemKind, ItemState } from "@/core/types";
import { trpc } from "@/lib/trpc-client";
import { useChatPaneController } from "@/ui/conversations/chat-pane-context";
import { buildSuggestSeed } from "@/ui/items/suggest-seeds";
import { Button } from "@/ui/primitives/button";

/**
 * Header button that opens the chat pane on a fresh thread and auto-fires a
 * "what should I do next on this item?" prompt. The agent stages proposals
 * exactly the same way it would for a typed message — no auto-confirm, the
 * user still reviews the diff in `ProposalDialog`.
 *
 * Disabled while a previous seed is still queued so a fast double-tap can't
 * spawn duplicate conversations before the chat pane has picked one up.
 */
export function SuggestActionButton({
  kind,
  state,
  title,
  body,
  commentCount,
}: {
  kind: ItemKind | null;
  state: ItemState | null;
  title: string;
  body: string | null;
  commentCount: number;
}) {
  const { requestOpenWithSeed, seedPending } = useChatPaneController();
  const globals = trpc.settings.globalList.useQuery();
  const actionBullets = (() => {
    const row = globals.data?.find((r) => r.key === "prompt.suggest-next-action");
    return typeof row?.value === "string" ? row.value : null;
  })();

  const onClick = () => {
    if (seedPending) return;
    requestOpenWithSeed(
      buildSuggestSeed({ kind, state, title, body, commentCount, actionBullets }),
    );
  };

  return (
    <Button
      type="button"
      size="xs"
      onClick={onClick}
      disabled={seedPending}
      title={seedPending ? "Opening chat…" : "Open chat with a 'next action' prompt"}
    >
      <Sparkles aria-hidden="true" />
      Suggest next action
    </Button>
  );
}
