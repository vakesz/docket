"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { ChatPane } from "@/ui/conversations/chat-pane";
import { ChatPaneProvider, useChatPaneController } from "@/ui/conversations/chat-pane-context";
import { BacklogPane } from "@/ui/items/backlog-pane";
import { prewarmMarkdown } from "@/ui/markdown/markdown-lazy";
import { ItemsShellLayout } from "@/ui/shell/items-shell-layout";

type Props = {
  projectSlug: string;
  staleThresholdDays: number | null;
  children: ReactNode;
};

/**
 * Client wrapper around the 3-pane workspace. Hosts the chat-pane
 * controller so the right pane only mounts when the user opens chat
 * from the item detail; absent that, the layout collapses to two panes
 * and the detail spans the full middle/right area.
 */
export function ItemsShell({ projectSlug, staleThresholdDays, children }: Props) {
  return (
    <ChatPaneProvider>
      <ItemsShellInner projectSlug={projectSlug} staleThresholdDays={staleThresholdDays}>
        {children}
      </ItemsShellInner>
    </ChatPaneProvider>
  );
}

function ItemsShellInner({ projectSlug, staleThresholdDays, children }: Props) {
  const { open } = useChatPaneController();
  const pathname = usePathname();
  const itemNumber = extractItemNumber(pathname, projectSlug);
  const showChat = open && Boolean(itemNumber);

  // Fetch the react-markdown bundle on idle while the user is reading the
  // backlog/detail. The first chat bubble would otherwise trigger this
  // download synchronously and the bubble paints empty for ~150ms while
  // the chunk lands. Idempotent — webpack dedupes the dynamic import.
  useEffect(() => {
    prewarmMarkdown();
  }, []);

  return (
    <ItemsShellLayout
      left={<BacklogPane projectSlug={projectSlug} staleThresholdDays={staleThresholdDays} />}
      middle={children}
      right={
        showChat && itemNumber ? (
          <ChatPane key={itemNumber} projectSlug={projectSlug} itemNumber={itemNumber} />
        ) : null
      }
    />
  );
}

function extractItemNumber(pathname: string | null, projectSlug: string): string | null {
  if (!pathname) return null;
  const prefix = `/projects/${projectSlug}/items/`;
  if (!pathname.startsWith(prefix)) return null;
  const tail = pathname.slice(prefix.length);
  const num = tail.split("/")[0]?.trim();
  return num ? num : null;
}
