"use client";

import { Button } from "@headlessui/react";
import { Sparkles } from "lucide-react";
import type { ItemKind, ItemState } from "@/core/types";
import { xsBorderButtonClass } from "@/lib/form-classes";
import { useChatPaneController } from "@/ui/conversations/chat-pane-context";
import { buildSuggestSeed } from "@/ui/items/suggest-seeds";

/**
 * Header button that opens the chat pane on a fresh thread and auto-fires a
 * "what should I do next on this item?" prompt. The agent stages proposals
 * exactly the same way it would for a typed message — no auto-confirm, the
 * user still reviews the diff in `ProposalDialog`.
 */
export function SuggestActionButton({
  kind,
  state,
  title,
  bodyMd,
  commentCount,
}: {
  kind: ItemKind | null;
  state: ItemState | null;
  title: string;
  bodyMd: string | null;
  commentCount: number;
}) {
  const { requestOpenWithSeed } = useChatPaneController();

  const onClick = () => {
    requestOpenWithSeed(buildSuggestSeed({ kind, state, title, bodyMd, commentCount }));
  };

  return (
    <Button
      type="button"
      onClick={onClick}
      title="Open chat with a 'next action' prompt"
      className={xsBorderButtonClass}
    >
      <Sparkles aria-hidden="true" className="size-3" />
      Suggest next action
    </Button>
  );
}
