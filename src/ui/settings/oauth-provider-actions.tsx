"use client";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";

export function OauthProviderActions({
  id,
  enabled,
  onEdit,
}: {
  id: string;
  enabled: boolean;
  onEdit: () => void;
}) {
  const utils = trpc.useUtils();
  const refresh = () => utils.oauthProviders.list.invalidate();

  const setEnabled = trpc.oauthProviders.setEnabled.useMutation({ onSuccess: refresh });
  const del = trpc.oauthProviders.delete.useMutation({ onSuccess: refresh });

  const pending = setEnabled.isPending || del.isPending;

  return (
    <div className="flex items-center gap-2">
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
              "Delete this OAuth provider? The sign-in button will disappear. Existing sessions stay valid until they expire.",
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
