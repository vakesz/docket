import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { createCaller } from "@/server/trpc-caller";
import { OauthProviderActions } from "@/ui/admin/oauth-provider-actions";
import { OauthProviderForm } from "@/ui/admin/oauth-provider-form";

const CALLBACK_PATHS: Record<string, string> = {
  github: "/api/auth/callback/github",
  azure_devops: "/api/auth/callback/azure-devops",
};

function callbackUrl(kind: string, base: string): string {
  const path = CALLBACK_PATHS[kind] ?? "/api/auth/callback/<kind>";
  return `${base.replace(/\/$/, "")}${path}`;
}

export default async function OauthProvidersAdminPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/");
  }

  const trpc = await createCaller();
  const rows = await trpc.oauthProviders.list();
  const publicBase = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").trim();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 bg-bg p-8 text-fg">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">OAuth providers</h1>
          <p className="text-sm text-fg-muted">
            Sign-in providers. NextAuth rebuilds its provider list per request from these rows.
          </p>
        </div>
        <Link href="/admin" className="text-sm text-fg-muted hover:text-fg">
          ← Admin
        </Link>
      </header>

      <section className="flex flex-col gap-2">
        {rows.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-center text-sm text-fg-muted">
            No OAuth providers yet. Until at least one row exists, no one can sign in.
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
                        {row.kind.replace("_", " ")}
                      </span>
                      {!row.enabled ? (
                        <span className="rounded-full bg-surface-alt px-2 py-0.5 text-xs text-fg-muted">
                          disabled
                        </span>
                      ) : null}
                    </div>
                    <p className="font-mono text-xs text-fg-muted">{row.clientId}</p>
                    <p className="text-xs text-fg-muted">
                      Callback URL:{" "}
                      <code className="rounded-sm bg-surface-alt px-1 py-0.5 font-mono text-fg">
                        {callbackUrl(row.kind, publicBase)}
                      </code>
                    </p>
                  </div>
                  <OauthProviderActions id={row.id} enabled={row.enabled} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <OauthProviderForm />
    </main>
  );
}
