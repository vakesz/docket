import { TRPCError } from "@trpc/server";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { mostRecent } from "@/lib/format";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { loadGlobalSetting } from "@/server/settings/effective";
import { requireSetupComplete } from "@/server/setup/guard";
import { createCaller } from "@/server/trpc-caller";
import { CommandPalette } from "@/ui/shell/command-palette";
import { ShortcutHelp } from "@/ui/shell/shortcut-help";
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

  // All five fetches are independent of each other, so they fan out at
  // once. `projects.get` is the only one that can short-circuit with a
  // 404; the rest do unnecessary work in that error path, which is fine
  // since the happy path (project visible) is the common case.
  let project: Awaited<ReturnType<typeof trpc.projects.get>>;
  let projects: Awaited<ReturnType<typeof trpc.projects.list>>;
  let readOnly: Awaited<ReturnType<typeof loadGlobalSetting<"app.read-only">>>;
  let pendingProposalsCount: number;
  let syncCursor: { watermark: Date | null; lastFullSyncAt: Date | null; updatedAt: Date } | null;
  try {
    [project, projects, readOnly, pendingProposalsCount, syncCursor] = await Promise.all([
      trpc.projects.get({ projectId }),
      trpc.projects.list(),
      loadGlobalSetting(db, "app.read-only"),
      trpc.proposals.count({ projectId, status: "pending" }),
      db.syncCursor.findUnique({
        where: { projectId },
        select: { watermark: true, lastFullSyncAt: true, updatedAt: true },
      }),
    ]);
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) {
      notFound();
    }
    throw err;
  }
  const userLabel = session.user.email ?? session.user.name ?? "you";
  const userImage = session.user.image ?? null;

  // Pick the most recent of (incremental watermark, full-sync timestamp,
  // row-update timestamp). The cursor row's updatedAt covers cases where a
  // sync ran but didn't bump either of the two payload columns.
  const lastSyncAt = syncCursor
    ? mostRecent([syncCursor.watermark, syncCursor.lastFullSyncAt, syncCursor.updatedAt])
    : null;

  const projectOptions = projects.map((p) => ({
    id: p.id,
    name: p.name,
    providerKind: p.providerKind,
  }));

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <WorkspaceProviders>
        <TopBar
          projects={projectOptions}
          currentProjectId={project.id}
          userLabel={userLabel}
          userImage={userImage}
          readOnly={readOnly}
        />
        <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
        <StatusFooter
          projectId={project.id}
          lastSyncAt={lastSyncAt}
          pendingProposals={pendingProposalsCount}
          readOnly={readOnly}
        />
        <CommandPalette projectId={project.id} projects={projectOptions} />
        <ShortcutHelp />
      </WorkspaceProviders>
    </div>
  );
}
