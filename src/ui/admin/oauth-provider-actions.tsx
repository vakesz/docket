"use client";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

export function OauthProviderActions({ id, enabled }: { id: string; enabled: boolean }) {
  const router = useRouter();
  const refresh = () => router.refresh();

  const setEnabled = trpc.oauthProviders.setEnabled.useMutation({ onSuccess: refresh });
  const del = trpc.oauthProviders.delete.useMutation({ onSuccess: refresh });

  const pending = setEnabled.isPending || del.isPending;

  return (
    <div className="flex items-center gap-2 text-xs">
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
              "Delete this OAuth provider? The sign-in button will disappear. Existing sessions stay valid until they expire.",
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
