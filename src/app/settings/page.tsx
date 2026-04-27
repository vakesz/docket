import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { requireSetupComplete } from "@/server/setup/guard";
import { SettingsForm } from "@/ui/settings/settings-form";

const sections = [
  {
    href: "/settings/llm-providers",
    label: "LLM providers",
    description:
      "OpenAI / Anthropic / etc. The agent loop picks one row per project (or the global default) on each turn.",
  },
  {
    href: "/settings/oauth-providers",
    label: "OAuth providers",
    description:
      "Sign-in providers. NextAuth rebuilds its provider list per request from these rows — adding a row makes its sign-in button appear immediately.",
  },
];

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
            Per-user preferences plus deployment-wide configuration. Theme lives in the top bar.
          </p>
        </div>
        <Link href="/" className="text-sm text-fg-muted hover:text-fg">
          ← Projects
        </Link>
      </header>

      <SettingsForm />

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium text-fg">Deployment</h2>
        <ul className="flex flex-col gap-3">
          {sections.map((s) => (
            <li
              key={s.href}
              className="rounded-2xl border border-border bg-surface p-4 shadow-sm transition hover:border-fg-faint"
            >
              <Link href={s.href} className="block">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium text-fg">{s.label}</span>
                  <span className="text-xs text-fg-faint">→</span>
                </div>
                <p className="mt-1 text-xs text-fg-muted">{s.description}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
