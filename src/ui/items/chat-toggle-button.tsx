"use client";

import { Button } from "@headlessui/react";
import { MessageSquare, MessageSquareOff } from "lucide-react";
import { xsBorderButtonClass } from "@/lib/form-classes";
import { useChatPaneController } from "@/ui/conversations/chat-pane-context";

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
      aria-pressed={open}
      onClick={() => setOpen(!open)}
      title={open ? "Close chat" : "Open chat"}
      className={xsBorderButtonClass}
    >
      <Icon aria-hidden="true" className="size-3" />
      {open ? "Close chat" : "Chat"}
    </Button>
  );
}
