import { TRPCError } from "@trpc/server";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth } from "@/server/auth";
import { requireSetupComplete } from "@/server/setup/guard";
import { createCaller } from "@/server/trpc-caller";
import { StatusFooter } from "@/ui/shell/status-footer";
import { TopBar } from "@/ui/shell/top-bar";

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

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <TopBar
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        currentProjectId={project.id}
        userLabel={userLabel}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-8">{children}</div>
      </main>
      <StatusFooter projectName={project.name} providerKind={project.providerKind} />
    </div>
  );
}
