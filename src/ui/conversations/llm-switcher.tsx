"use client";

import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";

type LlmRow = {
  id: string;
  kind: string;
  label: string;
  model: string;
  isDefault: boolean;
  enabled: boolean;
};

/**
 * Per-conversation LLM picker, surfaced in the chat-pane header.
 *
 * Per the migration sketch: even at launch (one OpenAI adapter) we keep
 * the affordance visible. When only the project default is available
 * the dropdown is disabled — but it exists, so adding a second provider
 * row in admin settings makes it interactive without a UI change.
 *
 * `currentOverrideId === null` means "use whatever the project default
 * resolves to"; the option list shows that as a synthetic top entry.
 */
export function LlmSwitcher({
  projectId,
  conversationId,
  currentOverrideId,
}: {
  projectId: string;
  conversationId: string | null;
  currentOverrideId: string | null;
}) {
  const utils = trpc.useUtils();
  const list = trpc.llmProviders.list.useQuery();
  const setOverride = trpc.conversations.setLlmOverride.useMutation({
    onSuccess: async () => {
      if (conversationId) {
        await utils.conversations.get.invalidate({ projectId, conversationId });
      }
    },
  });

  const rows = (list.data ?? []) as LlmRow[];
  const enabled = rows.filter((r) => r.enabled);
  const onlyOne = enabled.length <= 1;
  const disabled = !conversationId || onlyOne || setOverride.isPending;

  const value = currentOverrideId ?? "default";

  return (
    <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-fg-faint">
      <span>LLM</span>
      <SelectField
        className="rounded-md py-0.5 pl-2 pr-7 text-[11px] normal-case tracking-normal"
        value={value}
        disabled={disabled}
        onChange={(e) => {
          if (!conversationId) return;
          const next = e.target.value === "default" ? null : e.target.value;
          setOverride.mutate({ projectId, conversationId, llmProviderId: next });
        }}
      >
        <option value="default">{labelForDefault(rows)}</option>
        {enabled
          .filter((r) => !r.isDefault)
          .map((r) => (
            <option key={r.id} value={r.id}>
              {formatRow(r)}
            </option>
          ))}
      </SelectField>
    </span>
  );
}

function labelForDefault(rows: readonly LlmRow[]): string {
  const def = rows.find((r) => r.isDefault && r.enabled);
  if (!def) return "Project default";
  return `${formatRow(def)} (default)`;
}

function formatRow(r: LlmRow): string {
  const tail = r.model ? ` · ${r.model}` : "";
  return `${r.label}${tail}`;
}
