import type { ReactNode } from "react";
import { db } from "@/server/db";
import { loadGlobalSetting } from "@/server/settings/effective";
import { ItemsShell } from "@/ui/shell/items-shell";

/**
 * Wraps the items list and detail routes in the resizable 2-or-3-pane
 * shell. The chat pane is opt-in — it stays unmounted until the user
 * clicks the chat toggle inside the item detail header — so the backlog
 * + detail always have the full middle width when the user isn't
 * actively chatting.
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
    <ItemsShell
      projectId={projectId}
      staleThresholdDays={staleThresholdDays > 0 ? staleThresholdDays : null}
    >
      {children}
    </ItemsShell>
  );
}
