"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { ChatPane } from "@/ui/conversations/chat-pane";
import { ChatPaneProvider, useChatPaneController } from "@/ui/conversations/chat-pane-context";
import { BacklogPane } from "@/ui/items/backlog-pane";
import { ItemsShellLayout } from "@/ui/shell/items-shell-layout";

type Props = {
  projectId: string;
  staleThresholdDays: number | null;
  children: ReactNode;
};

/**
 * Client wrapper around the 3-pane workspace. Hosts the chat-pane
 * controller so the right pane only mounts when the user opens chat
 * from the item detail; absent that, the layout collapses to two panes
 * and the detail spans the full middle/right area.
 */
export function ItemsShell({ projectId, staleThresholdDays, children }: Props) {
  return (
    <ChatPaneProvider>
      <ItemsShellInner projectId={projectId} staleThresholdDays={staleThresholdDays}>
        {children}
      </ItemsShellInner>
    </ChatPaneProvider>
  );
}

function ItemsShellInner({ projectId, staleThresholdDays, children }: Props) {
  const { open } = useChatPaneController();
  const pathname = usePathname();
  const itemId = useMemo(() => extractItemId(pathname, projectId), [pathname, projectId]);
  const showChat = open && Boolean(itemId);

  return (
    <ItemsShellLayout
      left={<BacklogPane projectId={projectId} staleThresholdDays={staleThresholdDays} />}
      middle={children}
      right={
        showChat && itemId ? <ChatPane key={itemId} projectId={projectId} itemId={itemId} /> : null
      }
    />
  );
}

function extractItemId(pathname: string | null, projectId: string): string | null {
  if (!pathname) return null;
  const prefix = `/projects/${projectId}/items/`;
  if (!pathname.startsWith(prefix)) return null;
  const tail = pathname.slice(prefix.length);
  const id = tail.split("/")[0]?.trim();
  return id ? id : null;
}
