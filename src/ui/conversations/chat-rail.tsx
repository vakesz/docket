"use client";

import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { ChatPane } from "@/ui/conversations/chat-pane";

/**
 * Right-pane wrapper. Derives `itemId` from the current URL so the chat
 * rail stays mounted across item switches but rebinds its conversation
 * + stream state per item.
 *
 * When no item is selected (the items index page), shows a placeholder
 * instead of mounting ChatPane — without an itemId the conversation
 * router has nothing to scope to and the agent has no ticket context.
 *
 * TODO(port): toggle button (collapse / expand the rail) lands in
 * Phase 4 with the cmdk + global keyboard shortcuts.
 */
export function ChatRail({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const itemId = useMemo(() => extractItemId(pathname, projectId), [pathname, projectId]);

  if (!itemId) {
    return (
      <div className="flex h-full flex-col bg-bg">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-fg-muted">Chat</h2>
        </header>
        <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-fg-faint">
          Pick an item from the backlog to chat about it.
        </div>
      </div>
    );
  }

  return <ChatPane key={itemId} projectId={projectId} itemId={itemId} />;
}

function extractItemId(pathname: string | null, projectId: string): string | null {
  if (!pathname) return null;
  const prefix = `/projects/${projectId}/items/`;
  if (!pathname.startsWith(prefix)) return null;
  const tail = pathname.slice(prefix.length);
  const id = tail.split("/")[0]?.trim();
  return id ? id : null;
}
