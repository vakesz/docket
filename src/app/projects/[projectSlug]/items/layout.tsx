import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { db } from "@/db";
import { resolveEffectiveStaleThreshold } from "@/lib/staleness";
import { auth } from "@/server/auth";
import { projectForUser } from "@/server/projects/access";
import { loadProjectSetting, loadUserSetting } from "@/server/settings/effective";
import { ItemsShell } from "@/ui/shell/items-shell";

/**
 * Wraps the items list and detail routes in the resizable 2-or-3-pane
 * shell. The chat pane is opt-in — it stays unmounted until the user
 * clicks the chat toggle inside the item detail header — so the backlog
 * + detail always have the full middle width when the user isn't
 * actively chatting.
 *
 * `projectForUser` is `cache()`-wrapped, so the parent ProjectLayout's
 * `trpc.projects.get` (which goes through the same helper inside the
 * project-scoped middleware) and this lookup share one DB roundtrip
 * per request.
 */
export default async function ItemsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const userId = session.user.id;

  const project = await projectForUser(db, projectSlug, userId);
  if (!project) notFound();

  const [projectStale, userStale] = await Promise.all([
    loadProjectSetting(db, project.id, "items.stale-after-days"),
    loadUserSetting(db, userId, "items.stale-after-days.user"),
  ]);
  const staleThresholdDays = resolveEffectiveStaleThreshold(userStale, projectStale);

  return (
    <ItemsShell projectSlug={projectSlug} staleThresholdDays={staleThresholdDays}>
      {children}
    </ItemsShell>
  );
}
