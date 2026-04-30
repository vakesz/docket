"use client";

import { trpc } from "@/lib/trpc-client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";

type LlmRow = {
  id: string;
  kind: string;
  role: string;
  label: string;
  model: string;
  isDefault: boolean;
  enabled: boolean;
};

const DEFAULT_VALUE = "default";

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
  projectSlug,
  conversationId,
  currentOverrideId,
}: {
  projectSlug: string;
  conversationId: string | null;
  currentOverrideId: string | null;
}) {
  const utils = trpc.useUtils();
  const list = trpc.llmProviders.list.useQuery();
  const setOverride = trpc.conversations.setLlmOverride.useMutation({
    onSuccess: async () => {
      if (conversationId) {
        await utils.conversations.get.invalidate({ projectSlug, conversationId });
      }
    },
  });

  // Switcher is chat-only — guardrail rows are not selectable as a
  // conversation-level LLM and would silently fail role enforcement.
  const rows = ((list.data ?? []) as LlmRow[]).filter((r) => r.role === "chat");
  const enabled = rows.filter((r) => r.enabled);
  const onlyOne = enabled.length <= 1;
  const disabled = !conversationId || onlyOne || setOverride.isPending;

  const value = currentOverrideId ?? DEFAULT_VALUE;

  return (
    <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
      <span>LLM</span>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (!conversationId) return;
          const resolved = next === DEFAULT_VALUE ? null : next;
          setOverride.mutate({ projectSlug, conversationId, llmProviderId: resolved });
        }}
      >
        <SelectTrigger size="sm" className="h-6 py-0.5 text-[11px] normal-case tracking-normal">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_VALUE}>{labelForDefault(rows)}</SelectItem>
          {enabled
            .filter((r) => !r.isDefault)
            .map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {formatRow(r)}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
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
