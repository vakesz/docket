"use client";
import { xsBorderButtonClass, xsDangerButtonClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";

export function OauthProviderActions({ id, enabled }: { id: string; enabled: boolean }) {
  const utils = trpc.useUtils();
  const refresh = () => utils.oauthProviders.list.invalidate();

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
        className={xsDangerButtonClass}
      >
        Delete
      </button>
    </div>
  );
}
