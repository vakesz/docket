"use client";

import { Sparkles } from "lucide-react";
import type { ItemKind, ItemState } from "@/core/types";
import { useChatPaneController } from "@/ui/conversations/chat-pane-context";
import { buildSuggestSeed } from "@/ui/items/suggest-seeds";
import { Button } from "@/ui/primitives/button";

/**
 * Header button that opens the chat pane on a fresh thread and auto-fires a
 * "what should I do next on this item?" prompt. The agent stages proposals
 * exactly the same way it would for a typed message — no auto-confirm, the
 * user still reviews the diff in `ProposalDialog`.
 */
export function SuggestActionButton({
  kind,
  state,
}: {
  kind: ItemKind | null;
  state: ItemState | null;
}) {
  const { requestOpenWithSeed } = useChatPaneController();

  const onClick = () => {
    requestOpenWithSeed(buildSuggestSeed({ kind, state }));
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      onClick={onClick}
      title="Open chat with a 'next action' prompt"
    >
      <Sparkles aria-hidden="true" />
      Suggest next action
    </Button>
  );
}
