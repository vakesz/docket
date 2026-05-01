"use client";
import { useId } from "react";
import { useSettingsMap } from "@/lib/settings-client";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Label } from "@/ui/primitives/label";
import { DefaultProjectPicker } from "@/ui/settings/default-project-picker";
import { TimezonePicker } from "@/ui/settings/timezone-picker";
import { ThemePicker } from "@/ui/shell/theme-picker";

/**
 * Profile section — identity-shaped per-user preferences only: default
 * project picker, theme, display time zone. Theme is browser-local
 * (localStorage) rather than catalog-backed because the user's
 * OS-color-scheme preference can differ across devices and we don't want
 * a DB write to override that.
 *
 * Pane-specific preferences live alongside their pane: backlog/filter-bar
 * defaults under "Items list", reactions under "Item detail", chat keys
 * under "Chat". Sync cadence is project-scoped — see "Sync" in the
 * project settings.
 */
export function ProfilePanel() {
  const utils = trpc.useUtils();
  const settings = useSettingsMap();
  const update = trpc.settings.update.useMutation({
    onSuccess: async () => {
      await utils.settings.list.invalidate();
    },
  });

  const timezone = settings.str("display.timezone", "");
  const disabled = settings.list.isPending || update.isPending;

  const themeId = useId();
  const tzId = useId();

  return (
    <div className="flex flex-col gap-6">
      <DefaultProjectPicker />

      <div className="flex flex-col gap-1 border-border border-t pt-6">
        <Label htmlFor={themeId} className="font-medium text-foreground text-sm">
          Theme
        </Label>
        <p className="text-muted-foreground text-xs">
          Color scheme for this browser. Adaptive variants follow your OS&rsquo;s light/dark
          preference; a fixed theme overrides it.
        </p>
        <div id={themeId}>
          <ThemePicker />
        </div>
      </div>

      <div className="flex flex-col gap-1 border-border border-t pt-6">
        <Label htmlFor={tzId} className="font-medium text-foreground text-sm">
          Display time zone
        </Label>
        <p className="text-muted-foreground text-xs">
          Used for relative dates and the staleness tint window. Pick &ldquo;Browser local&rdquo; to
          follow whatever zone the browser reports.
        </p>
        <TimezonePicker
          id={tzId}
          value={timezone}
          disabled={disabled}
          onChange={(next) => update.mutate({ key: "display.timezone", value: next })}
        />
        {update.error ? (
          <Alert variant="destructive">
            <AlertDescription>{update.error.message}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </div>
  );
}
