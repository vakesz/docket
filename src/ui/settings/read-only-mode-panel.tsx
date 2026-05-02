"use client";

import { useId } from "react";
import { useGlobalSettingsMap } from "@/lib/settings-client";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Label } from "@/ui/primitives/label";
import { Switch } from "@/ui/primitives/switch";

/**
 * Deployment-wide kill-switch. When on, every mutation route — including
 * proposal confirms — is blocked. Reads stay open. Flip on for maintenance
 * windows; the agent registry strips mutating tools while it's active.
 */
export function ReadOnlyModePanel() {
  const utils = trpc.useUtils();
  const settings = useGlobalSettingsMap();
  const update = trpc.settings.globalUpdate.useMutation({
    onSuccess: async () => {
      await utils.settings.globalList.invalidate();
    },
  });

  const enabled = settings.bool("app.read-only", false);
  const disabled = settings.list.isPending || update.isPending;
  const switchId = useId();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label className="font-medium text-foreground text-sm">System read-only mode</Label>
        <p className="text-muted-foreground text-xs">
          When on, every mutation route — including proposal confirms — is blocked. Reads stay open.
          Flip on for maintenance windows.
        </p>
        <div className="flex items-center gap-2 text-foreground text-sm">
          <Switch
            id={switchId}
            checked={enabled}
            disabled={disabled}
            onCheckedChange={(next) => update.mutate({ key: "app.read-only", value: next })}
          />
          <Label htmlFor={switchId}>{enabled ? "Enabled — all writes blocked" : "Disabled"}</Label>
        </div>
      </div>
      {update.error ? (
        <Alert variant="destructive">
          <AlertDescription>{update.error.message}</AlertDescription>
        </Alert>
      ) : null}
      {settings.list.error ? (
        <Alert variant="destructive">
          <AlertDescription>{settings.list.error.message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
