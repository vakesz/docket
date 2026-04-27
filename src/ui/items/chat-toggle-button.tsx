"use client";

import { MessageSquare, MessageSquareOff } from "lucide-react";
import { useChatPaneController } from "@/ui/conversations/chat-pane-context";
import { Button } from "@/ui/primitives/button";

/**
 * Header button that toggles the right-hand chat pane. The pane is closed
 * by default so the detail/backlog get the full middle width unless the
 * user explicitly wants to chat about this item.
 */
export function ChatToggleButton() {
  const { open, setOpen } = useChatPaneController();
  const Icon = open ? MessageSquareOff : MessageSquare;

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      aria-pressed={open}
      onClick={() => setOpen(!open)}
      title={open ? "Close chat" : "Open chat"}
    >
      <Icon aria-hidden="true" />
      {open ? "Close chat" : "Chat"}
    </Button>
  );
}
