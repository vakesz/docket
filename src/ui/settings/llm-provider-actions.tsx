"use client";
import { useRouter } from "next/navigation";
import { xsBorderButtonClass } from "@/lib/form-classes";
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
  const router = useRouter();
  const refresh = () => router.refresh();

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
        <span className="rounded-md bg-accent px-2 py-1 text-xs font-semibold text-accent-fg">
          default
        </span>
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
        className="inline-flex items-center gap-1 rounded-md border border-danger/40 bg-surface px-2 py-1 text-xs text-danger-fg hover:bg-danger-bg/40 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Delete
      </button>
    </div>
  );
}
