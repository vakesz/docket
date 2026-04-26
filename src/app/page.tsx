import Link from "next/link";
import { auth } from "@/server/auth";
import { createCaller } from "@/server/trpc-caller";
import { CreateProjectForm } from "@/ui/projects/create-project-form";
import { SignInWithGitHubButton } from "@/ui/shell/sign-in-button";
import { SignOutButton } from "@/ui/shell/sign-out-button";

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 p-8 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">docket</h1>
        <p className="text-zinc-600 dark:text-zinc-400">Sign in to manage projects.</p>
        <SignInWithGitHubButton />
      </main>
    );
  }

  const trpc = await createCaller();
  const projects = await trpc.projects.list();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">docket</h1>
        <div className="flex items-center gap-3 text-sm text-zinc-500">
          <span>{session.user.email ?? session.user.name}</span>
          <SignOutButton />
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Projects</h2>
        {projects.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No projects yet — create your first one below.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {projects.map((p) => (
              <li
                key={p.id}
                className="rounded-md border border-zinc-200 p-3 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
              >
                <Link href={`/projects/${p.id}`} className="block">
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs uppercase tracking-wide text-zinc-500">
                      {p.providerKind.replace("_", " ")}
                    </span>
                  </div>
                  {p.description ? (
                    <p className="mt-1 text-xs text-zinc-500">{p.description}</p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <CreateProjectForm />
    </main>
  );
}
