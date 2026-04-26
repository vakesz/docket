import { auth, signIn, signOut } from "@/server/auth";
import { createCaller } from "@/server/trpc-caller";

export default async function Home() {
  const session = await auth();
  const trpc = await createCaller();
  const ping = await trpc.health.ping();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">docket</h1>

      {session?.user ? (
        <>
          <p className="text-zinc-600 dark:text-zinc-400">
            Signed in as{" "}
            <span className="font-medium">{session.user.email ?? session.user.name}</span>
          </p>
          <p className="rounded-md bg-emerald-100 px-4 py-2 font-mono text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
            health.ping → {ping}
          </p>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="rounded-full border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Sign out
            </button>
          </form>
        </>
      ) : (
        <>
          <p className="text-zinc-600 dark:text-zinc-400">
            Sign in to verify the tRPC + NextAuth wiring.
          </p>
          <form
            action={async () => {
              "use server";
              await signIn("github", { redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              Sign in with GitHub
            </button>
          </form>
        </>
      )}
    </main>
  );
}
