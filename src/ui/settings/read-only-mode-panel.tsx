"use client";

import { Field, Label, Switch } from "@headlessui/react";
import { switchThumbClass, switchTrackClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";

/**
 * Deployment-wide kill-switch. When on, every mutation route — including
 * proposal confirms — is blocked. Reads stay open. Flip on for maintenance
 * windows; the agent registry strips mutating tools while it's active.
 */
export function ReadOnlyModePanel() {
  const utils = trpc.useUtils();
  const list = trpc.settings.globalList.useQuery();
  const update = trpc.settings.globalUpdate.useMutation({
    onSuccess: async () => {
      await utils.settings.globalList.invalidate();
    },
  });

  const row = list.data?.find((r) => r.key === "app.read-only");
  const enabled = row?.value === true;
  const disabled = list.isPending || update.isPending;

  return (
    <div className="flex flex-col gap-3">
      <Field className="flex flex-col gap-1">
        <Label className="text-sm font-medium text-foreground">
          {row?.label ?? "System read-only mode"}
        </Label>
        <p className="text-xs text-muted-foreground">
          {row?.description ??
            "When on, every mutation route — including proposal confirms — is blocked. Reads stay open. Flip on for maintenance windows."}
        </p>
        <Field className="flex items-center gap-2 text-sm text-foreground">
          <Switch
            checked={enabled}
            disabled={disabled}
            onChange={(next) => update.mutate({ key: "app.read-only" as never, value: next })}
            className={switchTrackClass}
          >
            <span aria-hidden className={switchThumbClass} />
          </Switch>
          <Label>{enabled ? "Enabled — all writes blocked" : "Disabled"}</Label>
        </Field>
      </Field>
      {update.error ? <p className="text-xs text-destructive">{update.error.message}</p> : null}
      {list.error ? <p className="text-xs text-destructive">{list.error.message}</p> : null}
    </div>
  );
}
