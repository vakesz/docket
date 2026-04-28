"use client";
import { useState } from "react";
import { badgeClass, emptyStateClass } from "@/lib/form-classes";
import { nextAuthCallbackPath } from "@/lib/next-auth-provider-id";
import { trpc } from "@/lib/trpc-client";
import { useAutoRefreshIntervalMs } from "@/lib/use-auto-refresh";
import { OauthProviderActions } from "@/ui/settings/oauth-provider-actions";
import { OauthProviderForm } from "@/ui/settings/oauth-provider-form";

function callbackUrl(kind: string, base: string): string {
  return `${base.replace(/\/$/, "")}${nextAuthCallbackPath(kind)}`;
}

/** OAuth-providers section, mounted inside the unified settings page. */
export function OauthProvidersPanel({ publicBase }: { publicBase: string }) {
  const refetchInterval = useAutoRefreshIntervalMs();
  const list = trpc.oauthProviders.list.useQuery(undefined, { refetchInterval });
  const [editingId, setEditingId] = useState<string | null>(null);

  if (list.isPending) {
    return <p className="text-sm text-fg-faint">Loading providers…</p>;
  }
  if (list.error) {
    return <p className="text-sm text-danger-fg">{list.error.message}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium text-fg">Configured providers</h2>
        {list.data.length === 0 ? (
          <p className={emptyStateClass}>
            No OAuth providers yet. Until at least one row exists, no one can sign in.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.data.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4 shadow-sm"
              >
                {editingId === row.id ? (
                  <OauthProviderForm
                    mode="edit"
                    initial={{
                      id: row.id,
                      kind: row.kind,
                      label: row.label,
                      clientId: row.clientId,
                      scopes: row.scopes,
                      baseUrl: row.baseUrl,
                    }}
                    onDone={() => setEditingId(null)}
                  />
                ) : (
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-baseline gap-2">
                        <span className="font-medium text-fg">{row.label}</span>
                        <span className="text-xs uppercase tracking-wide text-fg-muted">
                          {row.kind.replace("_", " ")}
                        </span>
                        {!row.enabled ? <span className={badgeClass}>disabled</span> : null}
                      </div>
                      <p className="font-mono text-xs text-fg-muted">{row.clientId}</p>
                      <p className="text-xs text-fg-muted">
                        Callback URL:{" "}
                        <code className="rounded bg-surface-alt px-1 py-0.5 font-mono text-fg">
                          {callbackUrl(row.kind, publicBase)}
                        </code>
                      </p>
                    </div>
                    <OauthProviderActions
                      id={row.id}
                      enabled={row.enabled}
                      onEdit={() => setEditingId(row.id)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div aria-hidden="true" className="my-4 h-px bg-border" />

      <OauthProviderForm />
    </div>
  );
}
