"use client";
import { useState } from "react";
import { nextAuthCallbackPath } from "@/lib/next-auth-provider-id";
import { trpc } from "@/lib/trpc-client";
import { useAutoRefreshIntervalMs } from "@/lib/use-auto-refresh";
import { Badge } from "@/ui/primitives/badge";
import { Separator } from "@/ui/primitives/separator";
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
    return <p className="text-sm text-muted-foreground/70">Loading providers…</p>;
  }
  if (list.error) {
    return <p className="text-sm text-destructive">{list.error.message}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium text-foreground">Configured providers</h2>
        {list.data.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
            No OAuth providers yet. Until at least one row exists, no one can sign in.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.data.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 shadow-sm"
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
                        <span className="font-medium text-foreground">{row.label}</span>
                        <span className="text-xs uppercase tracking-wide text-muted-foreground">
                          {row.kind.replace("_", " ")}
                        </span>
                        {!row.enabled ? <Badge variant="outline">disabled</Badge> : null}
                      </div>
                      <p className="font-mono text-xs text-muted-foreground">{row.clientId}</p>
                      <p className="text-xs text-muted-foreground">
                        Callback URL:{" "}
                        <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
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

      <Separator />

      <OauthProviderForm />
    </div>
  );
}
