import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { resolveEffectiveStaleThreshold } from "@/lib/staleness";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { loadProjectSetting, loadUserSetting } from "@/server/settings/effective";
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
  params: Promise<{ projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  // Session and project lookup are independent — fan them out so the
  // first await batches both round-trips. Settings reads then run as a
  // second wave once we know the project id and user id.
  const [session, project] = await Promise.all([
    auth(),
    db.project.findUnique({
      where: { slug: projectSlug },
      select: { id: true },
    }),
  ]);
  if (!project) notFound();
  const userId = session?.user?.id ?? null;

  const [projectStale, userStale] = await Promise.all([
    loadProjectSetting(db, project.id, "items.stale-after-days"),
    userId
      ? loadUserSetting(db, userId, "items.stale-after-days.user")
      : Promise.resolve(-1 as number),
  ]);
  const staleThresholdDays = resolveEffectiveStaleThreshold(userStale, projectStale);

  return (
    <ItemsShell projectSlug={projectSlug} staleThresholdDays={staleThresholdDays}>
      {children}
    </ItemsShell>
  );
}
