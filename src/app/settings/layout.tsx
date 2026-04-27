import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { loadGlobalSetting } from "@/server/settings/effective";
import { requireSetupComplete } from "@/server/setup/guard";
import { createCaller } from "@/server/trpc-caller";
import { CommandPalette } from "@/ui/shell/command-palette";
import { StatusFooter } from "@/ui/shell/status-footer";
import { TopBar } from "@/ui/shell/top-bar";

/**
 * Settings shares the workspace chrome — same TopBar (with project
 * switcher and account menu) and same StatusFooter — only the inner
 * pane differs. Mirrors main: settings is a peer of the items workspace,
 * not a separate app.
 *
 * The `?project=<id>` query param is passed by the AccountMenu link so
 * we can keep the topbar's project switcher pointing at the project the
 * user just left. We don't read it here — the page server component
 * does — but we honor it when building the topbar's `currentProjectId`.
 */
export default async function SettingsLayout({
  children,
  // Next 16 doesn't pass searchParams to layouts, so the page is the one
  // that resolves them. We rely on the user's default project + listing
  // to drive the topbar selection.
}: {
  children: ReactNode;
}) {
  await requireSetupComplete();
  const session = await auth();
  if (!session?.user) {
    redirect("/");
  }

  const userId = session.user.id;
  const trpc = await createCaller();

  const [me, projects, readOnly] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { defaultProjectId: true },
    }),
    trpc.projects.list(),
    loadGlobalSetting(db, "app.read-only"),
  ]);

  const projectOptions = projects.map((p) => ({ id: p.id, name: p.name }));

  // Topbar's project switcher: prefer the user's pinned default, fall back
  // to the most-recent membership. Switching projects from the topbar
  // takes the user out of /settings into that project's items shell.
  const currentProjectId =
    (me?.defaultProjectId && projectOptions.find((p) => p.id === me.defaultProjectId)?.id) ??
    projectOptions[0]?.id ??
    null;

  const userLabel = session.user.email ?? session.user.name ?? "you";

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <TopBar projects={projectOptions} currentProjectId={currentProjectId} userLabel={userLabel} />
      <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
      <StatusFooter
        projectId={currentProjectId}
        projectName={projectOptions.find((p) => p.id === currentProjectId)?.name ?? null}
        providerKind={null}
        lastSyncAt={null}
        pendingProposals={0}
        readOnly={readOnly}
      />
      {currentProjectId ? (
        <CommandPalette projectId={currentProjectId} projects={projectOptions} />
      ) : null}
    </div>
  );
}
