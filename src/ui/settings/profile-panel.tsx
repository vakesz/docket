"use client";
import { Field, Label } from "@headlessui/react";
import { trpc } from "@/lib/trpc-client";
import { NumberField } from "@/ui/forms/number-field";
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
  const list = trpc.settings.list.useQuery();
  const update = trpc.settings.update.useMutation({
    onSuccess: async () => {
      await utils.settings.list.invalidate();
    },
  });

  const timezoneRaw = list.data?.find((r) => r.key === "display.timezone")?.value;
  const timezone = typeof timezoneRaw === "string" ? timezoneRaw : "";
  const autoRefreshRaw = list.data?.find((r) => r.key === "ui.auto-refresh-seconds")?.value;
  const autoRefreshSeconds = typeof autoRefreshRaw === "number" ? autoRefreshRaw : 0;
  const autoRefreshMinutes = Math.round(autoRefreshSeconds / 60);
  const disabled = list.isPending || update.isPending;

  return (
    <div className="flex flex-col gap-6">
      <DefaultProjectPicker />

      <Field className="flex flex-col gap-1 border-t border-border pt-6">
        <Label className="text-sm font-medium text-fg">Theme</Label>
        <p className="text-xs text-fg-muted">
          Color scheme for this browser. Adaptive variants follow your OS&rsquo;s light/dark
          preference; a fixed theme overrides it.
        </p>
        <ThemePicker />
      </Field>

      <Field className="flex flex-col gap-1 border-t border-border pt-6">
        <Label className="text-sm font-medium text-fg">Display time zone</Label>
        <p className="text-xs text-fg-muted">
          Used for relative dates and the staleness tint window. Pick &ldquo;Browser local&rdquo; to
          follow whatever zone the browser reports.
        </p>
        <TimezonePicker
          value={timezone}
          disabled={disabled}
          onChange={(next) => update.mutate({ key: "display.timezone" as never, value: next })}
        />
        {update.error ? <p className="text-xs text-danger-fg">{update.error.message}</p> : null}
      </Field>

      <Field className="flex flex-col gap-1 border-t border-border pt-6">
        <Label className="text-sm font-medium text-fg">Auto-refresh interval (minutes)</Label>
        <p className="text-xs text-fg-muted">
          How often dashboard list views (LLM providers, OAuth providers, and similar) silently
          re-fetch in the background. 0 disables auto-refresh; manual refetches still work. Maximum
          60 (one hour).
        </p>
        <NumberField
          min={0}
          max={60}
          step={1}
          value={autoRefreshMinutes}
          disabled={list.isPending}
          onCommit={(next) =>
            update.mutate({ key: "ui.auto-refresh-seconds" as never, value: next * 60 })
          }
          className="max-w-[8rem]"
        />
        {update.error ? <p className="text-xs text-danger-fg">{update.error.message}</p> : null}
      </Field>
    </div>
  );
}
