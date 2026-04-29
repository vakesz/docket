"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { useAutoRefreshIntervalMs } from "@/lib/use-auto-refresh";
import { Alert, AlertDescription, AlertTitle } from "@/ui/primitives/alert";
import { Badge } from "@/ui/primitives/badge";
import { Separator } from "@/ui/primitives/separator";
import { LlmProviderActions } from "@/ui/settings/llm-provider-actions";
import { LlmProviderForm } from "@/ui/settings/llm-provider-form";

type Role = "chat" | "guardrail";

type Row = {
  id: string;
  kind: string;
  role: string;
  label: string;
  model: string;
  baseUrl: string;
  inputPriceCentsPerMtok: number | null;
  outputPriceCentsPerMtok: number | null;
  isDefault: boolean;
  enabled: boolean;
};

/**
 * LLM-providers section, mounted inside the unified settings page. Reads
 * the row list client-side so the parent stays a single "use client"
 * island instead of having to thread server-fetched data through props.
 *
 * Rows are grouped by role: Chat rows feed the agent loop; Guardrail rows
 * feed the prompt-injection / topic-scope / output-safety classifier.
 * Each role has an independent "default" — the form's role toggle decides
 * which one is being created.
 */
export function LlmProvidersPanel() {
  const refetchInterval = useAutoRefreshIntervalMs();
  const list = trpc.llmProviders.list.useQuery(undefined, { refetchInterval });
  const [editingId, setEditingId] = useState<string | null>(null);

  if (list.isPending) {
    return <p className="text-sm text-muted-foreground-faint">Loading providers…</p>;
  }
  if (list.error) {
    return <p className="text-sm text-destructive">{list.error.message}</p>;
  }

  const rows = list.data as Row[];
  const chatRows = rows.filter((r) => r.role === "chat");
  const guardrailRows = rows.filter((r) => r.role === "guardrail");

  const defaultRoleAvailability: Record<Role, boolean> = {
    chat: !chatRows.some((r) => r.isDefault),
    guardrail: !guardrailRows.some((r) => r.isDefault),
  };

  return (
    <div className="flex flex-col gap-6">
      <Alert variant="warning">
        <AlertTitle>Adding an Azure AI Foundry model</AlertTitle>
        <AlertDescription>
          <p>
            Use the project&rsquo;s OpenAI v1 endpoint as the Base URL — the path must end with{" "}
            <code className="rounded bg-card px-1 py-0.5 font-mono text-foreground">
              /openai/v1/
            </code>
            . Set <span className="font-medium">Model</span> to the deployment name shown in Foundry
            &rarr; Model deployments (for example <code className="font-mono">gpt-5</code>).
          </p>
          <p>
            Template:{" "}
            <code className="rounded bg-card px-1 py-0.5 font-mono text-foreground">
              https://&lt;resource&gt;.services.ai.azure.com/api/projects/&lt;project&gt;/openai/v1/
            </code>
          </p>
        </AlertDescription>
      </Alert>

      <Section
        title="Chat models"
        description="Power the agent loop. Per-conversation overrides still win at runtime."
        rows={chatRows}
        editingId={editingId}
        setEditingId={setEditingId}
      />

      <Section
        title="Guardrail models"
        description="Run alongside chat to classify prompt injection, off-topic input, and (optionally) output safety. A small / cheap model is recommended (e.g. gpt-5-nano)."
        rows={guardrailRows}
        editingId={editingId}
        setEditingId={setEditingId}
      />

      <Separator />

      <LlmProviderForm mode="create" defaultRoleAvailability={defaultRoleAvailability} />
    </div>
  );
}

function Section({
  title,
  description,
  rows,
  editingId,
  setEditingId,
}: {
  title: string;
  description: string;
  rows: readonly Row[];
  editingId: string | null;
  setEditingId: (next: string | null) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>
      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          None configured yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 shadow-sm"
            >
              {editingId === row.id ? (
                <LlmProviderForm
                  mode="edit"
                  initial={{
                    id: row.id,
                    kind: row.kind,
                    role: row.role === "guardrail" ? "guardrail" : "chat",
                    label: row.label,
                    model: row.model ?? "",
                    baseUrl: row.baseUrl ?? "",
                    inputPriceCentsPerMtok: row.inputPriceCentsPerMtok ?? null,
                    outputPriceCentsPerMtok: row.outputPriceCentsPerMtok ?? null,
                  }}
                  onClose={() => setEditingId(null)}
                />
              ) : (
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium text-foreground">{row.label}</span>
                      <span className="text-xs uppercase tracking-wide text-muted-foreground">
                        {row.kind}
                      </span>
                      {!row.enabled ? <Badge variant="outline">disabled</Badge> : null}
                      {row.inputPriceCentsPerMtok === null ||
                      row.outputPriceCentsPerMtok === null ? (
                        <Badge variant="outline">no price</Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {row.model || "(default model)"}
                      {row.baseUrl ? ` · ${row.baseUrl}` : ""}
                    </p>
                    {row.inputPriceCentsPerMtok !== null && row.outputPriceCentsPerMtok !== null ? (
                      <p className="text-xs text-muted-foreground">
                        ${(row.inputPriceCentsPerMtok / 100).toFixed(2)} in · $
                        {(row.outputPriceCentsPerMtok / 100).toFixed(2)} out per Mtok
                      </p>
                    ) : null}
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
  );
}
