import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { resolveEffectiveStaleThreshold } from "@/lib/staleness";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { loadProjectSetting, loadUserSetting } from "@/server/settings/effective";
import { createCaller } from "@/server/trpc-caller";
import { DetailPane } from "@/ui/items/detail-pane";

// React's `cache()` dedupes on argument equality within one server request,
// so `generateMetadata` and the page component share a single tRPC fetch
// instead of doubling DB round-trips on every detail-page load.
const loadItem = cache(async (projectId: string, itemId: string) => {
  const trpc = await createCaller();
  return trpc.items.get({ projectId, itemId });
});

const loadProject = cache(async (projectId: string) => {
  const trpc = await createCaller();
  return trpc.projects.get({ projectId });
});

/** Strip the noisiest markdown so the meta description reads as plain prose. */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; itemId: string }>;
}): Promise<Metadata> {
  const { projectId, itemId } = await params;
  try {
    const item = await loadItem(projectId, itemId);
    const title = `${item.providerItemId} · ${item.title}`;
    const description = item.descriptionMd
      ? stripMarkdown(item.descriptionMd).slice(0, 160) || undefined
      : undefined;
    return { title, description };
  } catch {
    // Auth/permission/not-found errors are surfaced by the page handler's
    // own `notFound()` — meta generation should never throw.
    return {};
  }
}

export default async function ItemDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; itemId: string }>;
}) {
  const { projectId, itemId } = await params;

  let item: Awaited<ReturnType<typeof loadItem>>;
  let project: Awaited<ReturnType<typeof loadProject>>;
  try {
    [item, project] = await Promise.all([loadItem(projectId, itemId), loadProject(projectId)]);
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) {
      notFound();
    }
    throw err;
  }

  const session = await auth();
  const userId = session?.user?.id ?? null;
  const [projectStale, userStale] = await Promise.all([
    loadProjectSetting(db, projectId, "items.stale-after-days"),
    userId
      ? loadUserSetting(db, userId, "items.stale-after-days.user")
      : Promise.resolve(-1 as number),
  ]);
  const staleThresholdDays = resolveEffectiveStaleThreshold(userStale, projectStale);

  return (
    <DetailPane
      projectId={projectId}
      providerKind={project.providerKind}
      capabilities={project.capabilities}
      item={item}
      staleThresholdDays={staleThresholdDays}
    />
  );
}
