import { TRPCError } from "@trpc/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth } from "@/server/auth";
import { requireSetupComplete } from "@/server/setup/guard";
import { createCaller } from "@/server/trpc-caller";
import { ProjectSwitcher } from "@/ui/shell/project-switcher";
import { SignOutButton } from "@/ui/shell/sign-out-button";

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

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="text-sm font-semibold tracking-tight text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
          >
            docket
          </Link>
          <span className="text-zinc-300 dark:text-zinc-700">/</span>
          <ProjectSwitcher
            projects={projects.map((p) => ({ id: p.id, name: p.name }))}
            currentProjectId={project.id}
          />
        </div>
        <div className="flex items-center gap-3 text-sm text-zinc-500">
          <span>{session.user.email ?? session.user.name}</span>
          <SignOutButton />
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
