import { redirect } from "next/navigation";
import { db } from "@/server/db";
import { getSetupStatus } from "@/server/setup/status";

/**
 * Friendly explanation page surfaced by `requireSetupComplete()` when the
 * deployment hasn't finished its bootstrap. Once both halves exist, this
 * page redirects home rather than show an obsolete "setup required"
 * screen — flipping the sticky bit happens inside `getSetupStatus`.
 *
 * Notably this page does NOT call `requireSetupComplete()` itself; that
 * would bounce the redirect against itself.
 */

export default async function SetupRequiredPage() {
  const status = await getSetupStatus(db);
  if (status.complete) {
    redirect("/");
  }

  const items: Array<{ label: string; ok: boolean; hint: string }> = [
    {
      label: "LLM provider",
      ok: status.hasLlm,
      hint: "Set DEV_OPENAI_API_KEY in .env.local and restart `bun run dev`, or insert a row into LlmProvider directly.",
    },
    {
      label: "OAuth provider",
      ok: status.hasOauth,
      hint: "Set DEV_GITHUB_CLIENT_ID + DEV_GITHUB_CLIENT_SECRET in .env.local and restart `bun run dev`, or insert a row into OauthProviderConfig directly.",
    },
  ];

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Setup required</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Docket needs at least one LLM provider and one OAuth provider before it can sign anyone in
          or run the agent. Fill in what's missing below, then reload.
        </p>
      </header>

      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <li
            key={item.label}
            className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium">{item.label}</span>
              <span
                className={
                  item.ok
                    ? "text-xs uppercase tracking-wide text-emerald-600 dark:text-emerald-400"
                    : "text-xs uppercase tracking-wide text-amber-600 dark:text-amber-400"
                }
              >
                {item.ok ? "configured" : "missing"}
              </span>
            </div>
            {!item.ok ? (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{item.hint}</p>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Once both halves are in place this page redirects home automatically.
      </p>
    </main>
  );
}
