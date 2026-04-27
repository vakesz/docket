import { TRPCError } from "@trpc/server";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { loadGlobalSetting } from "@/server/settings/effective";
import { requireSetupComplete } from "@/server/setup/guard";
import { createCaller } from "@/server/trpc-caller";
import { CommandPalette } from "@/ui/shell/command-palette";
import { StatusFooter } from "@/ui/shell/status-footer";
import { TopBar } from "@/ui/shell/top-bar";
import { WorkspaceProviders } from "@/ui/shell/workspace-providers";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  await requireSetupComplete();
  const session = await auth();
  if (!session?.user) {
    redirect("/");
  }

  const { projectId } = await params;
  const trpc = await createCaller();

  let project: Awaited<ReturnType<typeof trpc.projects.get>>;
  try {
    project = await trpc.projects.get({ projectId });
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) {
      notFound();
    }
    throw err;
  }

  const projects = await trpc.projects.list();
  const userLabel = session.user.email ?? session.user.name ?? "you";
  const userImage = session.user.image ?? null;

  const [readOnly, pendingProposals, syncCursor] = await Promise.all([
    loadGlobalSetting(db, "app.read-only"),
    trpc.proposals.list({ projectId, status: "pending", limit: 100 }),
    db.syncCursor.findUnique({
      where: { projectId },
      select: { watermark: true, lastFullSyncAt: true, updatedAt: true },
    }),
  ]);

  // Pick the most recent of (incremental watermark, full-sync timestamp,
  // row-update timestamp). The cursor row's updatedAt covers cases where a
  // sync ran but didn't bump either of the two payload columns.
  const lastSyncAt = syncCursor
    ? mostRecent([syncCursor.watermark, syncCursor.lastFullSyncAt, syncCursor.updatedAt])
    : null;

  const projectOptions = projects.map((p) => ({ id: p.id, name: p.name }));

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <WorkspaceProviders>
        <TopBar
          projects={projectOptions}
          currentProjectId={project.id}
          userLabel={userLabel}
          userImage={userImage}
        />
        <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
        <StatusFooter
          projectId={project.id}
          projectName={project.name}
          providerKind={project.providerKind}
          lastSyncAt={lastSyncAt}
          pendingProposals={pendingProposals.length}
          readOnly={readOnly}
        />
        <CommandPalette projectId={project.id} projects={projectOptions} />
      </WorkspaceProviders>
    </div>
  );
}

function mostRecent(dates: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (!best || d.getTime() > best.getTime()) best = d;
  }
  return best;
}
