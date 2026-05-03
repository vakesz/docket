import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { resolveEffectiveStaleThreshold } from "@/lib/staleness";
import { getSession } from "@/server/auth";
import { loadProjectSetting, loadUserSetting } from "@/server/settings/effective";
import { createCaller } from "@/server/trpc-caller";
import { DetailPane } from "@/ui/items/detail-pane";

// React's `cache()` dedupes on argument equality within one server request,
// so `generateMetadata` and the page component share a single tRPC fetch
// instead of doubling DB round-trips on every detail-page load.
const loadItem = cache(async (projectSlug: string, itemNumber: string) => {
  const trpc = await createCaller();
  return trpc.items.get({ projectSlug, itemNumber });
});

const loadProject = cache(async (projectSlug: string) => {
  const trpc = await createCaller();
  return trpc.projects.get({ projectSlug });
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
  params: Promise<{ projectSlug: string; itemNumber: string }>;
}): Promise<Metadata> {
  const { projectSlug, itemNumber } = await params;
  try {
    const item = await loadItem(projectSlug, itemNumber);
    const title = `${item.providerItemId} · ${item.title}`;
    const description = item.description
      ? stripMarkdown(item.description).slice(0, 160) || undefined
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
  params: Promise<{ projectSlug: string; itemNumber: string }>;
}) {
  const { projectSlug, itemNumber } = await params;

  // getSession() doesn't depend on the item or project fetch, so include
  // it in the same fan-out. The session result is awaited up-front but its
  // round-trip overlaps with the tRPC reads instead of running after.
  // `getSession` is the typed no-arg view of NextAuth's multi-overload
  // `auth` — the cast is owned by `@/server/auth` so call sites stay clean.
  type LoadedItem = Awaited<ReturnType<typeof loadItem>>;
  type LoadedProject = Awaited<ReturnType<typeof loadProject>>;
  let item: LoadedItem;
  let project: LoadedProject;
  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    [item, project, session] = await Promise.all([
      loadItem(projectSlug, itemNumber),
      loadProject(projectSlug),
      getSession(),
    ]);
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) {
      notFound();
    }
    throw err;
  }

  const userId = session?.user?.id ?? null;
  const [projectStale, userStale, showHeaderReactions, showCommentReactions] = await Promise.all([
    loadProjectSetting(db, project.id, "items.stale-after-days"),
    userId
      ? loadUserSetting(db, userId, "items.stale-after-days.user")
      : Promise.resolve<number>(-1),
    userId ? loadUserSetting(db, userId, "items.show-reactions-header") : Promise.resolve(true),
    userId ? loadUserSetting(db, userId, "items.show-reactions-comments") : Promise.resolve(true),
  ]);
  const staleThresholdDays = resolveEffectiveStaleThreshold(userStale, projectStale);

  return (
    <DetailPane
      projectSlug={projectSlug}
      providerKind={project.providerKind}
      capabilities={project.capabilities}
      providerHasAvatars={project.hasAvatarFetcher}
      item={item}
      staleThresholdDays={staleThresholdDays}
      showHeaderReactions={showHeaderReactions}
      showCommentReactions={showCommentReactions}
    />
  );
}
