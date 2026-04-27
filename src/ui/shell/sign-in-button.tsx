import { primaryButtonClass } from "@/lib/form-classes";
import { signIn } from "@/server/auth";

export function SignInWithGitHubButton({ redirectTo = "/" }: { redirectTo?: string }) {
  return (
    <form
      action={async () => {
        "use server";
        await signIn("github", { redirectTo });
      }}
    >
      <button type="submit" className={primaryButtonClass}>
        Sign in with GitHub
      </button>
    </form>
  );
}
