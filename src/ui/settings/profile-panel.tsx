"use client";
import { useId } from "react";
import { useSettingsMap } from "@/lib/settings-client";
import { trpc } from "@/lib/trpc-client";
import { NumberField } from "@/ui/forms/number-field";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Label } from "@/ui/primitives/label";
import { DefaultProjectPicker } from "@/ui/settings/default-project-picker";
import { TimezonePicker } from "@/ui/settings/timezone-picker";
import { ThemePicker } from "@/ui/shell/theme-picker";

/**
 * Profile section — identity-shaped per-user preferences only: default
 * project picker, theme, display time zone, and dashboard polling. Theme
 * is browser-local (localStorage) rather than catalog-backed because the
 * user's OS-color-scheme preference can differ across devices and we
 * don't want a DB write to override that.
 *
 * Pane-specific preferences live alongside their pane: backlog/filter-bar
 * defaults under "Items list", reactions under "Item detail", chat keys
 * under "Chat".
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
  const autoRefreshSeconds = settings.num("ui.auto-refresh-seconds", 0);
  const autoRefreshMinutes = Math.round(autoRefreshSeconds / 60);
  const disabled = settings.list.isPending || update.isPending;

  const themeId = useId();
  const tzId = useId();
  const refreshId = useId();

  return (
    <div className="flex flex-col gap-6">
      <DefaultProjectPicker />

      <div className="flex flex-col gap-1 border-t border-border pt-6">
        <Label htmlFor={themeId} className="text-sm font-medium text-foreground">
          Theme
        </Label>
        <p className="text-xs text-muted-foreground">
          Color scheme for this browser. Adaptive variants follow your OS&rsquo;s light/dark
          preference; a fixed theme overrides it.
        </p>
        <div id={themeId}>
          <ThemePicker />
        </div>
      </div>

      <div className="flex flex-col gap-1 border-t border-border pt-6">
        <Label htmlFor={tzId} className="text-sm font-medium text-foreground">
          Display time zone
        </Label>
        <p className="text-xs text-muted-foreground">
          Used for relative dates and the staleness tint window. Pick &ldquo;Browser local&rdquo; to
          follow whatever zone the browser reports.
        </p>
        <TimezonePicker
          id={tzId}
          value={timezone}
          disabled={disabled}
          onChange={(next) => update.mutate({ key: "display.timezone" as never, value: next })}
        />
        {update.error ? (
          <Alert variant="destructive">
            <AlertDescription>{update.error.message}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      <div className="flex flex-col gap-1 border-t border-border pt-6">
        <Label htmlFor={refreshId} className="text-sm font-medium text-foreground">
          Background sync interval (minutes)
        </Label>
        <p className="text-xs text-muted-foreground">
          While a project is open, sync from the provider every N minutes and refetch dashboard list
          views (LLM providers, OAuth providers, and similar) on the same cadence. The footer's
          "synced X ago" tracks each sync. 0 disables — the manual sync button still works. Maximum
          60 (one hour); ≥ 2 minutes recommended.
        </p>
        <NumberField
          id={refreshId}
          min={0}
          max={60}
          step={1}
          value={autoRefreshMinutes}
          disabled={disabled}
          onCommit={(next) =>
            update.mutate({ key: "ui.auto-refresh-seconds" as never, value: next * 60 })
          }
          className="max-w-[8rem]"
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
