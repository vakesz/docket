import { redirect } from "next/navigation";
import { setupCardClass } from "@/lib/form-classes";
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
    <main className="flex min-h-screen items-center justify-center bg-bg p-8 text-fg">
      <div className={`${setupCardClass} flex flex-col gap-6`}>
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Setup required</h1>
          <p className="text-sm text-fg-muted">
            Docket needs at least one LLM provider and one OAuth provider before it can sign anyone
            in or run the agent. Fill in what's missing below, then reload.
          </p>
        </header>

        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.label} className="rounded-2xl border border-border bg-surface-alt p-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium text-fg">{item.label}</span>
                <span
                  className={
                    item.ok
                      ? "text-xs uppercase tracking-wide text-success-fg"
                      : "text-xs uppercase tracking-wide text-warning-fg"
                  }
                >
                  {item.ok ? "configured" : "missing"}
                </span>
              </div>
              {!item.ok ? <p className="mt-2 text-xs text-fg-muted">{item.hint}</p> : null}
            </li>
          ))}
        </ul>

        <p className="text-xs text-fg-faint">
          Once both halves are in place this page redirects home automatically.
        </p>
      </div>
    </main>
  );
}
