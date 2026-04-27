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
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 bg-bg p-8 text-fg">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">LLM providers</h1>
          <p className="text-sm text-fg-muted">
            One row per vendor key. The default flag — at most one — is the global fallback when a
            project hasn&rsquo;t picked its own.
          </p>
        </div>
        <Link href="/admin" className="text-sm text-fg-muted hover:text-fg">
          ← Admin
        </Link>
      </header>

      <section className="flex flex-col gap-2">
        {rows.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-center text-sm text-fg-muted">
            No LLM providers yet. Add one below to give the agent a backend.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4 shadow-sm"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium text-fg">{row.label}</span>
                      <span className="text-xs uppercase tracking-wide text-fg-muted">
                        {row.kind}
                      </span>
                      {!row.enabled ? (
                        <span className="rounded-full bg-surface-alt px-2 py-0.5 text-xs text-fg-muted">
                          disabled
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-fg-muted">
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
