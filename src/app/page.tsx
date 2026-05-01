import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { requireSetupComplete } from "@/server/setup/guard";
import { CreateProjectForm } from "@/ui/projects/create-project-form";
import { DocketLogo } from "@/ui/setup/docket-logo";
import { SignInButtons } from "@/ui/shell/sign-in-button";

export default async function Home() {
  // Fan out the setup-gate check and the session read — neither depends on
  // the other, so batching saves a round-trip on every landing-page render.
  const [, session] = await Promise.all([requireSetupComplete(), auth()]);

  if (!session?.user) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 bg-background p-8 text-center text-foreground">
        <DocketLogo size={50} />
        <h1 className="font-semibold text-3xl tracking-tight">docket</h1>
        <p className="text-muted-foreground text-sm">Sign in to manage projects.</p>
        <SignInButtons />
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
  if (!userId) {
    redirect("/api/auth/signin");
  }
  const me = await db.user.findUnique({
    where: { id: userId },
    select: { defaultProjectId: true },
  });

  // Run the default-project access check and the most-recent-touched
  // fallback in parallel. The fallback only matters when the default is
  // missing or stale, but speculating on it shaves a roundtrip in that
  // path and is a no-op cost when the default redirect fires.
  const accessOr = [{ ownerUserId: userId }, { memberships: { some: { userId } } }];
  const [defaultProject, fallback] = await Promise.all([
    me?.defaultProjectId
      ? db.project.findFirst({
          where: { id: me.defaultProjectId, archivedAt: null, OR: accessOr },
          select: { slug: true },
        })
      : Promise.resolve(null),
    db.project.findFirst({
      where: { archivedAt: null, OR: accessOr },
      orderBy: [{ updatedAt: "desc" }],
      select: { slug: true },
    }),
  ]);

  if (defaultProject?.slug) {
    redirect(`/projects/${defaultProject.slug}/items`);
  }
  if (fallback) {
    redirect(`/projects/${fallback.slug}/items`);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 bg-background p-8 text-center text-foreground">
      <h1 className="font-semibold text-3xl tracking-tight">Welcome to docket</h1>
      <p className="text-muted-foreground text-sm">
        Create your first project to get started — it'll become your landing page automatically.
      </p>
      <CreateProjectForm />
    </main>
  );
}
