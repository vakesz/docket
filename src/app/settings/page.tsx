import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { requireSetupComplete } from "@/server/setup/guard";
import { SettingsForm } from "@/ui/settings/settings-form";

export default async function SettingsPage() {
  await requireSetupComplete();
  const session = await auth();
  if (!session?.user) {
    redirect("/");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 bg-bg p-8 text-fg">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-fg-muted">
            Per-user preferences. Saved as you change them. Theme lives in the top bar.
          </p>
        </div>
        <Link href="/" className="text-sm text-fg-muted hover:text-fg">
          ← Projects
        </Link>
      </header>

      <SettingsForm />
    </main>
  );
}
