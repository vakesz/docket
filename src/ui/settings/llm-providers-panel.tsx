"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { LlmProviderActions } from "@/ui/settings/llm-provider-actions";
import { LlmProviderEditForm } from "@/ui/settings/llm-provider-edit-form";
import { LlmProviderForm } from "@/ui/settings/llm-provider-form";

/**
 * LLM-providers section, mounted inside the unified settings page. Reads
 * the row list client-side so the parent stays a single "use client"
 * island instead of having to thread server-fetched data through props.
 */
export function LlmProvidersPanel() {
  const list = trpc.llmProviders.list.useQuery();
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
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-fg">LLM providers</h2>
        <p className="text-sm text-fg-muted">
          One row per vendor key. The default flag — at most one — is the global fallback when a
          project hasn&rsquo;t picked its own.
        </p>
      </header>

      {list.data.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-center text-sm text-fg-muted">
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

      <LlmProviderForm canBeDefault={noDefaultYet} />
    </div>
  );
}
