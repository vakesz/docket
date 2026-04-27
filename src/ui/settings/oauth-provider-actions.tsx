"use client";
import { useRouter } from "next/navigation";
import { xsBorderButtonClass } from "@/lib/form-classes";
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
              "Delete this OAuth provider? The sign-in button will disappear. Existing sessions stay valid until they expire.",
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
