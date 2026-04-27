"use client";
import { trpc } from "@/lib/trpc-client";
import { OauthProviderActions } from "@/ui/settings/oauth-provider-actions";
import { OauthProviderForm } from "@/ui/settings/oauth-provider-form";

const CALLBACK_PATHS: Record<string, string> = {
  github: "/api/auth/callback/github",
  azure_devops: "/api/auth/callback/azure-devops",
};

function callbackUrl(kind: string, base: string): string {
  const path = CALLBACK_PATHS[kind] ?? "/api/auth/callback/<kind>";
  return `${base.replace(/\/$/, "")}${path}`;
}

/** OAuth-providers section, mounted inside the unified settings page. */
export function OauthProvidersPanel({ publicBase }: { publicBase: string }) {
  const list = trpc.oauthProviders.list.useQuery();

  if (list.isPending) {
    return <p className="text-sm text-fg-faint">Loading providers…</p>;
  }
  if (list.error) {
    return <p className="text-sm text-danger-fg">{list.error.message}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-fg">OAuth providers</h2>
        <p className="text-sm text-fg-muted">
          Sign-in providers. NextAuth rebuilds its provider list per request from these rows.
        </p>
      </header>

      {list.data.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-center text-sm text-fg-muted">
          No OAuth providers yet. Until at least one row exists, no one can sign in.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.data.map((row) => (
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

      <OauthProviderForm />
    </div>
  );
}
