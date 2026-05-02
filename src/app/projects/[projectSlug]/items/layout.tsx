import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { asProjectId, asUserId } from "@/core/types";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { resolveEffectiveStaleThreshold } from "@/lib/staleness";
import { auth } from "@/server/auth";
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
    db.query.projects.findFirst({
      where: eq(projects.slug, projectSlug),
      columns: { id: true },
    }),
  ]);
  if (!project) notFound();
  const userId = session?.user?.id ?? null;

  const [projectStale, userStale] = await Promise.all([
    loadProjectSetting(db, asProjectId(project.id), "items.stale-after-days"),
    userId
      ? loadUserSetting(db, asUserId(userId), "items.stale-after-days.user")
      : Promise.resolve<number>(-1),
  ]);
  const staleThresholdDays = resolveEffectiveStaleThreshold(userStale, projectStale);

  return (
    <ItemsShell projectSlug={projectSlug} staleThresholdDays={staleThresholdDays}>
      {children}
    </ItemsShell>
  );
}
