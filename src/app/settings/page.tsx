import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { SettingsForm } from "@/ui/settings/settings-form";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-zinc-500">Per-user preferences. Saved as you change them.</p>
        </div>
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          ← Projects
        </Link>
      </header>

      <SettingsForm />
    </main>
  );
}
