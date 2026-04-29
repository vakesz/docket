"use client";

import { Field, Label, Switch } from "@headlessui/react";
import { switchThumbClass, switchTrackClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";

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
  const list = trpc.settings.list.useQuery();
  const update = trpc.settings.update.useMutation({
    onSuccess: async () => {
      await utils.settings.list.invalidate();
    },
  });

  const headerRaw = list.data?.find((r) => r.key === HEADER_KEY)?.value;
  const headerOn = typeof headerRaw === "boolean" ? headerRaw : true;
  const commentsRaw = list.data?.find((r) => r.key === COMMENTS_KEY)?.value;
  const commentsOn = typeof commentsRaw === "boolean" ? commentsRaw : true;

  const disabled = list.isPending || update.isPending;

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

        <Field className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">
            Show reactions on item header
          </Label>
          <p className="text-xs text-muted-foreground">
            Controls the reactions strip below the item title. Comment reactions are unaffected.
          </p>
          <Field className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              checked={headerOn}
              disabled={disabled}
              onChange={(next) => update.mutate({ key: HEADER_KEY as never, value: next })}
              className={switchTrackClass}
            >
              <span aria-hidden className={switchThumbClass} />
            </Switch>
            <Label>{headerOn ? "Visible" : "Hidden"}</Label>
          </Field>
        </Field>

        <Field className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">Show reactions in comments</Label>
          <p className="text-xs text-muted-foreground">
            Controls the reactions strip below each comment. Header reactions are unaffected.
          </p>
          <Field className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              checked={commentsOn}
              disabled={disabled}
              onChange={(next) => update.mutate({ key: COMMENTS_KEY as never, value: next })}
              className={switchTrackClass}
            >
              <span aria-hidden className={switchThumbClass} />
            </Switch>
            <Label>{commentsOn ? "Visible" : "Hidden"}</Label>
          </Field>
        </Field>
      </section>

      {update.error ? <p className="text-xs text-destructive">{update.error.message}</p> : null}
    </div>
  );
}
