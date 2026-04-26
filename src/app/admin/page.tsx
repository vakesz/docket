import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";

export default async function AdminIndexPage() {
  // Admin pages are protected but unconditional w.r.t. setup state — the
  // operator needs to reach them precisely when bootstrap is half-finished.
  // Auth is still required so an unauth visitor doesn't see the surface.
  const session = await auth();
  if (!session?.user) {
    redirect("/");
  }

  const sections = [
    {
      href: "/admin/llm-providers",
      label: "LLM providers",
      description:
        "OpenAI / Anthropic / etc. The agent loop picks one row per project (or the global default) on each turn.",
    },
    {
      href: "/admin/oauth-providers",
      label: "OAuth providers",
      description:
        "Sign-in providers. NextAuth rebuilds its provider list per request from these rows — adding a row makes its sign-in button appear immediately.",
    },
  ];

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
          <p className="text-sm text-zinc-500">Deployment-wide configuration.</p>
        </div>
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          ← Projects
        </Link>
      </header>

      <ul className="flex flex-col gap-3">
        {sections.map((s) => (
          <li
            key={s.href}
            className="rounded-md border border-zinc-200 p-4 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
          >
            <Link href={s.href} className="block">
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{s.label}</span>
                <span className="text-xs text-zinc-500">→</span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">{s.description}</p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
