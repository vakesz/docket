"use client";
import { accentBadgeClass, xsBorderButtonClass, xsDangerButtonClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";

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
    <div className="flex items-center gap-2 text-xs">
      {!isDefault ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => setDefault.mutate({ id })}
          className={xsBorderButtonClass}
        >
          Set default
        </button>
      ) : (
        <span className={accentBadgeClass}>default</span>
      )}
      <button type="button" disabled={pending} onClick={onEdit} className={xsBorderButtonClass}>
        Edit
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => setEnabled.mutate({ id, enabled: !enabled })}
        className={xsBorderButtonClass}
      >
        {enabled ? "Disable" : "Enable"}
      </button>
      <button
        type="button"
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
        className={xsDangerButtonClass}
      >
        Delete
      </button>
    </div>
  );
}
