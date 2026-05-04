import { TRPCError } from "@trpc/server";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { db } from "@/db";
import { auth } from "@/server/auth";
import { loadGlobalSetting } from "@/server/settings/effective";
import { requireSetupComplete } from "@/server/setup/guard";
import { createCaller } from "@/server/trpc-caller";
import { CommandPalette } from "@/ui/shell/command-palette";
import { ShortcutHelp } from "@/ui/shell/shortcut-help";
import { SidebarDrawerProvider } from "@/ui/shell/sidebar-drawer-context";
import { StatusFooter } from "@/ui/shell/status-footer";
import { TopBar } from "@/ui/shell/top-bar";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectSlug: string }>;
}) {
  // requireSetupComplete and auth are both single indexed DB lookups with
  // no dependency between them — fan them out so the layout's first await
  // batches both round-trips instead of stacking them.
  const [, session] = await Promise.all([requireSetupComplete(), auth()]);
  if (!session?.user) {
    redirect("/");
  }

  const { projectSlug } = await params;
  const trpc = await createCaller();

  // All four fetches are independent of each other, so they fan out at
  // once. `projects.get` is the only one that can short-circuit with a
  // 404; the rest do unnecessary work in that error path, which is fine
  // since the happy path (project visible) is the common case.
  let project: Awaited<ReturnType<typeof trpc.projects.get>>;
  let projects: Awaited<ReturnType<typeof trpc.projects.list>>;
  let readOnly: Awaited<ReturnType<typeof loadGlobalSetting<"app.read-only">>>;
  let pendingProposalsCount: number;
  try {
    [project, projects, readOnly, pendingProposalsCount] = await Promise.all([
      trpc.projects.get({ projectSlug }),
      trpc.projects.list(),
      loadGlobalSetting(db, "app.read-only"),
      trpc.proposals.count({ projectSlug, status: "pending" }),
    ]);
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) {
      notFound();
    }
    throw err;
  }
  const userLabel = session.user.email ?? session.user.name ?? "you";
  const userImage = session.user.image ?? null;

  const projectOptions = projects.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    providerKind: p.providerKind,
  }));

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <SidebarDrawerProvider>
        <TopBar
          projects={projectOptions}
          currentProjectSlug={project.slug}
          userLabel={userLabel}
          userImage={userImage}
          readOnly={readOnly}
        />
        <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
        <StatusFooter
          projectSlug={project.slug}
          pendingProposals={pendingProposalsCount}
          readOnly={readOnly}
        />
        <CommandPalette projectSlug={project.slug} projects={projectOptions} />
        <ShortcutHelp />
      </SidebarDrawerProvider>
    </div>
  );
}
