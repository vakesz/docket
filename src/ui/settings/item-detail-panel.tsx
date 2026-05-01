"use client";

import { useId } from "react";
import { useSettingsMap } from "@/lib/settings-client";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Label } from "@/ui/primitives/label";
import { Switch } from "@/ui/primitives/switch";

const HEADER_KEY = "items.show-reactions-header";
const COMMENTS_KEY = "items.show-reactions-comments";

/**
 * Item detail section — per-user knobs for what shows on the item detail
 * page. Currently exposes two independent reaction-visibility toggles (one
 * for the item header, one for comments). Sync still pulls reactions
 * regardless; these are personal view preferences.
 */
export function ItemDetailPanel() {
  const utils = trpc.useUtils();
  const settings = useSettingsMap();
  const update = trpc.settings.update.useMutation({
    onSuccess: async () => {
      await utils.settings.list.invalidate();
    },
  });

  const headerOn = settings.bool(HEADER_KEY, true);
  const commentsOn = settings.bool(COMMENTS_KEY, true);

  const disabled = settings.list.isPending || update.isPending;
  const headerId = useId();
  const commentsId = useId();

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-foreground">Reactions</h3>
          <p className="text-xs text-muted-foreground">
            Hide reaction pickers and existing chips on the detail page. Sync still pulls reactions;
            flip these off when you don't care to see or post them.
          </p>
        </header>

        <div className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">
            Show reactions on item header
          </Label>
          <p className="text-xs text-muted-foreground">
            Controls the reactions strip below the item title. Comment reactions are unaffected.
          </p>
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              id={headerId}
              checked={headerOn}
              disabled={disabled}
              onCheckedChange={(next) => update.mutate({ key: HEADER_KEY as never, value: next })}
            />
            <Label htmlFor={headerId}>{headerOn ? "Visible" : "Hidden"}</Label>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">Show reactions in comments</Label>
          <p className="text-xs text-muted-foreground">
            Controls the reactions strip below each comment. Header reactions are unaffected.
          </p>
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              id={commentsId}
              checked={commentsOn}
              disabled={disabled}
              onCheckedChange={(next) => update.mutate({ key: COMMENTS_KEY as never, value: next })}
            />
            <Label htmlFor={commentsId}>{commentsOn ? "Visible" : "Hidden"}</Label>
          </div>
        </div>
      </section>

      {update.error ? (
        <Alert variant="destructive">
          <AlertDescription>{update.error.message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
