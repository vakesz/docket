import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { createCaller } from "@/server/trpc-caller";
import { LlmProviderActions } from "@/ui/admin/llm-provider-actions";
import { LlmProviderForm } from "@/ui/admin/llm-provider-form";

export default async function LlmProvidersAdminPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/");
  }

  const trpc = await createCaller();
  const rows = await trpc.llmProviders.list();
  const noDefaultYet = !rows.some((r) => r.isDefault);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">LLM providers</h1>
          <p className="text-sm text-zinc-500">
            One row per vendor key. The default flag — at most one — is the global fallback when a
            project hasn't picked its own.
          </p>
        </div>
        <Link
          href="/admin"
          className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          ← Admin
        </Link>
      </header>

      <section className="flex flex-col gap-2">
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No LLM providers yet. Add one below to give the agent a backend.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium">{row.label}</span>
                      <span className="text-xs uppercase tracking-wide text-zinc-500">
                        {row.kind}
                      </span>
                      {!row.enabled ? (
                        <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                          disabled
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-zinc-500">
                      {row.model || "(default model)"}
                      {row.baseUrl ? ` · ${row.baseUrl}` : ""}
                    </p>
                  </div>
                  <LlmProviderActions id={row.id} isDefault={row.isDefault} enabled={row.enabled} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <LlmProviderForm canBeDefault={noDefaultYet} />
    </main>
  );
}
