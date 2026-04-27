import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { requireSetupComplete } from "@/server/setup/guard";
import { CreateProjectForm } from "@/ui/projects/create-project-form";
import { SignInWithGitHubButton } from "@/ui/shell/sign-in-button";

export default async function Home() {
  await requireSetupComplete();
  const session = await auth();

  if (!session?.user) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 bg-bg p-8 text-center text-fg">
        <h1 className="text-3xl font-semibold tracking-tight">docket</h1>
        <p className="text-sm text-fg-muted">Sign in to manage projects.</p>
        <SignInWithGitHubButton />
      </main>
    );
  }

  // Landing redirects into the 3-pane shell of the user's default project,
  // falling back to the most-recently-touched membership. The "create your
  // first project" empty state below is reached only when the user has zero
  // projects (or every default they could have picked has since been
  // archived/deleted — User.defaultProjectId is SetNull on delete, so a
  // stale id presents as null).
  const userId = session.user.id;
  const me = await db.user.findUnique({
    where: { id: userId },
    select: { defaultProjectId: true },
  });

  const defaultId = me?.defaultProjectId
    ? (
        await db.project.findFirst({
          where: {
            id: me.defaultProjectId,
            archivedAt: null,
            OR: [{ ownerUserId: userId }, { memberships: { some: { userId } } }],
          },
          select: { id: true },
        })
      )?.id
    : null;

  if (defaultId) {
    redirect(`/projects/${defaultId}/items`);
  }

  const fallback = await db.project.findFirst({
    where: {
      archivedAt: null,
      OR: [{ ownerUserId: userId }, { memberships: { some: { userId } } }],
    },
    orderBy: [{ updatedAt: "desc" }],
    select: { id: true },
  });
  if (fallback) {
    redirect(`/projects/${fallback.id}/items`);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 bg-bg p-8 text-center text-fg">
      <h1 className="text-3xl font-semibold tracking-tight">Welcome to docket</h1>
      <p className="text-sm text-fg-muted">
        Create your first project to get started — it'll become your landing page automatically.
      </p>
      <CreateProjectForm />
    </main>
  );
}
