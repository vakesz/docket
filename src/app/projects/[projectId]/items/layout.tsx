import type { ReactNode } from "react";
import { db } from "@/server/db";
import { loadGlobalSetting } from "@/server/settings/effective";
import { ChatRail } from "@/ui/conversations/chat-rail";
import { BacklogPane } from "@/ui/items/backlog-pane";
import { ItemsShellLayout } from "@/ui/shell/items-shell-layout";

/**
 * Wraps the items list and detail routes in the resizable 3-pane shell so
 * the backlog stays mounted while users click through items in the middle
 * pane. The right pane hosts the chat rail, which itself decides whether
 * to mount the per-item chat (when an itemId is in the URL) or a hint
 * placeholder. The middle slot is whatever child route renders.
 */
export default async function ItemsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const staleThresholdDays = await loadGlobalSetting(db, "items.stale-after-days");

  return (
    <ItemsShellLayout
      left={
        <BacklogPane
          projectId={projectId}
          staleThresholdDays={staleThresholdDays > 0 ? staleThresholdDays : null}
        />
      }
      middle={children}
      right={<ChatRail projectId={projectId} />}
    />
  );
}
