import { signIn } from "@/server/auth";

export function SignInWithGitHubButton({ redirectTo = "/" }: { redirectTo?: string }) {
  return (
    <form
      action={async () => {
        "use server";
        await signIn("github", { redirectTo });
      }}
    >
      <button
        type="submit"
        className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
      >
        Sign in with GitHub
      </button>
    </form>
  );
}
