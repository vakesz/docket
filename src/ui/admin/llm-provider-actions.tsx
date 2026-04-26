"use client";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

export function LlmProviderActions({
  id,
  isDefault,
  enabled,
}: {
  id: string;
  isDefault: boolean;
  enabled: boolean;
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
          className="rounded-full border border-zinc-300 px-3 py-0.5 text-zinc-700 hover:border-zinc-500 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
        >
          Set default
        </button>
      ) : (
        <span className="rounded-full bg-emerald-100 px-3 py-0.5 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
          default
        </span>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() => setEnabled.mutate({ id, enabled: !enabled })}
        className="rounded-full border border-zinc-300 px-3 py-0.5 text-zinc-700 hover:border-zinc-500 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
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
        className="rounded-full border border-red-300 px-3 py-0.5 text-red-700 hover:border-red-500 disabled:opacity-50 dark:border-red-900 dark:text-red-300"
      >
        Delete
      </button>
    </div>
  );
}
