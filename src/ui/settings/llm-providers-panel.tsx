"use client";
import { useState } from "react";
import { badgeClass, emptyStateClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { useAutoRefreshIntervalMs } from "@/lib/use-auto-refresh";
import { LlmProviderActions } from "@/ui/settings/llm-provider-actions";
import { LlmProviderEditForm } from "@/ui/settings/llm-provider-edit-form";
import { LlmProviderForm } from "@/ui/settings/llm-provider-form";

/**
 * LLM-providers section, mounted inside the unified settings page. Reads
 * the row list client-side so the parent stays a single "use client"
 * island instead of having to thread server-fetched data through props.
 */
export function LlmProvidersPanel() {
  const refetchInterval = useAutoRefreshIntervalMs();
  const list = trpc.llmProviders.list.useQuery(undefined, { refetchInterval });
  const [editingId, setEditingId] = useState<string | null>(null);

  if (list.isPending) {
    return <p className="text-sm text-fg-faint">Loading providers…</p>;
  }
  if (list.error) {
    return <p className="text-sm text-danger-fg">{list.error.message}</p>;
  }

  const noDefaultYet = !list.data.some((r) => r.isDefault);

  return (
    <div className="flex flex-col gap-4">
      <aside
        role="note"
        className="rounded-2xl border border-warning/40 bg-warning-bg/40 p-4 text-xs text-warning-fg"
      >
        <p className="mb-1 font-medium">Adding an Azure AI Foundry model</p>
        <p>
          Use the project&rsquo;s OpenAI v1 endpoint as the Base URL — the path must end with{" "}
          <code className="rounded bg-surface px-1 py-0.5 font-mono text-fg">/openai/v1/</code>. Set{" "}
          <span className="font-medium">Model</span> to the deployment name shown in Foundry &rarr;
          Model deployments (for example <code className="font-mono">gpt-5</code>).
        </p>
        <p className="mt-2">
          Template:{" "}
          <code className="rounded bg-surface px-1 py-0.5 font-mono text-fg">
            https://&lt;resource&gt;.services.ai.azure.com/api/projects/&lt;project&gt;/openai/v1/
          </code>
        </p>
      </aside>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium text-fg">Configured providers</h2>
        {list.data.length === 0 ? (
          <p className={emptyStateClass}>
            No LLM providers yet. Add one below to give the agent a backend.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.data.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4 shadow-sm"
              >
                {editingId === row.id ? (
                  <LlmProviderEditForm
                    initial={{
                      id: row.id,
                      kind: row.kind,
                      label: row.label,
                      model: row.model ?? "",
                      baseUrl: row.baseUrl ?? "",
                    }}
                    onClose={() => setEditingId(null)}
                  />
                ) : (
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-baseline gap-2">
                        <span className="font-medium text-fg">{row.label}</span>
                        <span className="text-xs uppercase tracking-wide text-fg-muted">
                          {row.kind}
                        </span>
                        {!row.enabled ? <span className={badgeClass}>disabled</span> : null}
                      </div>
                      <p className="text-xs text-fg-muted">
                        {row.model || "(default model)"}
                        {row.baseUrl ? ` · ${row.baseUrl}` : ""}
                      </p>
                    </div>
                    <LlmProviderActions
                      id={row.id}
                      isDefault={row.isDefault}
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

      <LlmProviderForm canBeDefault={noDefaultYet} />
    </div>
  );
}
