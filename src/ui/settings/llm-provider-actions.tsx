"use client";
import { trpc } from "@/lib/trpc-client";
import { Badge } from "@/ui/primitives/badge";
import { Button } from "@/ui/primitives/button";

export function LlmProviderActions({
  id,
  isDefault,
  enabled,
  onEdit,
}: {
  id: string;
  isDefault: boolean;
  enabled: boolean;
  onEdit: () => void;
}) {
  const utils = trpc.useUtils();
  const refresh = () => utils.llmProviders.list.invalidate();

  const setDefault = trpc.llmProviders.setDefault.useMutation({ onSuccess: refresh });
  const setEnabled = trpc.llmProviders.setEnabled.useMutation({ onSuccess: refresh });
  const del = trpc.llmProviders.delete.useMutation({ onSuccess: refresh });

  const pending = setDefault.isPending || setEnabled.isPending || del.isPending;

  return (
    <div className="flex items-center gap-2">
      {isDefault ? (
        <Badge variant="default">default</Badge>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={pending}
          onClick={() => setDefault.mutate({ id })}
        >
          Set default
        </Button>
      )}
      <Button type="button" variant="outline" size="xs" disabled={pending} onClick={onEdit}>
        Edit
      </Button>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={pending}
        onClick={() => setEnabled.mutate({ id, enabled: !enabled })}
      >
        {enabled ? "Disable" : "Enable"}
      </Button>
      <Button
        type="button"
        variant="destructive"
        size="xs"
        disabled={pending}
        onClick={() => {
          if (
            confirm(
              "Delete this LLM provider? Existing conversations that referenced it will fall back to the default.",
            )
          ) {
            del.mutate({ id });
          }
        }}
      >
        Delete
      </Button>
    </div>
  );
}
