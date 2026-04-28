"use client";
import { Field, Input, Label, Switch } from "@headlessui/react";
import { useEffect, useState } from "react";
import { fieldClass, switchThumbClass, switchTrackClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";
import { DefaultProjectPicker } from "@/ui/settings/default-project-picker";
import { ThemePicker } from "@/ui/shell/theme-picker";

/**
 * Profile section — per-user preferences. Default-project picker, theme,
 * and chat.send-on-enter. Theme is browser-local (localStorage) rather
 * than catalog-backed because the user's OS-color-scheme preference can
 * differ across devices and we don't want a DB write to override that.
 */
export function ProfilePanel() {
  const utils = trpc.useUtils();
  const list = trpc.settings.list.useQuery();
  const update = trpc.settings.update.useMutation({
    onSuccess: async () => {
      await utils.settings.list.invalidate();
    },
  });

  const sendOnEnter = list.data?.find((r) => r.key === "chat.send-on-enter")?.value ?? true;
  const maxVisibleTagsRaw = list.data?.find((r) => r.key === "items.max-visible-tags")?.value;
  const maxVisibleTags = typeof maxVisibleTagsRaw === "number" ? maxVisibleTagsRaw : 2;
  const showArchivedBucketRaw = list.data?.find(
    (r) => r.key === "items.show-archived-bucket",
  )?.value;
  const showArchivedBucket =
    typeof showArchivedBucketRaw === "boolean" ? showArchivedBucketRaw : true;
  const backlogSortRaw = list.data?.find((r) => r.key === "backlog.default-sort")?.value;
  const backlogSort = typeof backlogSortRaw === "string" ? backlogSortRaw : "updated";
  const backlogStateRaw = list.data?.find((r) => r.key === "backlog.default-state-filter")?.value;
  const backlogState = typeof backlogStateRaw === "string" ? backlogStateRaw : "open";
  const backlogDensityRaw = list.data?.find((r) => r.key === "backlog.density")?.value;
  const backlogDensity = typeof backlogDensityRaw === "string" ? backlogDensityRaw : "cozy";
  const timezoneRaw = list.data?.find((r) => r.key === "display.timezone")?.value;
  const timezone = typeof timezoneRaw === "string" ? timezoneRaw : "";
  const autoRefreshRaw = list.data?.find((r) => r.key === "ui.auto-refresh-seconds")?.value;
  const autoRefresh = typeof autoRefreshRaw === "number" ? autoRefreshRaw : 0;

  return (
    <div className="flex flex-col gap-6">
      <DefaultProjectPicker />

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <span className="text-sm font-medium text-fg">Theme</span>
        <p className="text-xs text-fg-muted">
          Color scheme for this browser. Adaptive variants follow your OS&rsquo;s light/dark
          preference; a fixed theme overrides it.
        </p>
        <ThemePicker />
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <span className="text-sm font-medium text-fg">Backlog — show Archived bucket</span>
        <p className="text-xs text-fg-muted">
          When on, the backlog filter bar offers an Archived bucket alongside Open / Closed / All.
          Archived rows remain reachable via the All-states bucket either way.
        </p>
        <Field className="flex items-center gap-2 text-sm text-fg">
          <Switch
            checked={showArchivedBucket}
            disabled={update.isPending || list.isPending}
            onChange={(next) =>
              update.mutate({
                key: "items.show-archived-bucket" as never,
                value: next,
              })
            }
            className={switchTrackClass}
          >
            <span aria-hidden className={switchThumbClass} />
          </Switch>
          <Label>{showArchivedBucket ? "Visible" : "Hidden"}</Label>
        </Field>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <span className="text-sm font-medium text-fg">Backlog row — max tags shown</span>
        <p className="text-xs text-fg-muted">
          How many tag chips render inline on each backlog row before the rest collapse into a +N
          badge. Set to 0 to always collapse.
        </p>
        <Input
          type="number"
          min={0}
          max={20}
          step={1}
          value={maxVisibleTags}
          disabled={update.isPending || list.isPending}
          onChange={(e) => {
            const next = Number.parseInt(e.target.value, 10);
            if (!Number.isFinite(next) || next < 0) return;
            update.mutate({
              key: "items.max-visible-tags" as never,
              value: next,
            });
          }}
          className={`${fieldClass} max-w-[6rem]`}
        />
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <span className="text-sm font-medium text-fg">Backlog — default sort</span>
        <p className="text-xs text-fg-muted">
          Initial sort order when a project's backlog opens. Per-view sort still wins.
        </p>
        <SelectField
          value={backlogSort}
          disabled={update.isPending || list.isPending}
          onChange={(e) =>
            update.mutate({
              key: "backlog.default-sort" as never,
              value: e.target.value,
            })
          }
          wrapperClassName="max-w-[10rem]"
        >
          <option value="updated">Updated</option>
          <option value="created">Created</option>
          <option value="priority">Priority</option>
          <option value="title">Title</option>
        </SelectField>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <span className="text-sm font-medium text-fg">Backlog — default state filter</span>
        <p className="text-xs text-fg-muted">
          Initial state-bucket filter applied when the backlog opens.
        </p>
        <SelectField
          value={backlogState}
          disabled={update.isPending || list.isPending}
          onChange={(e) =>
            update.mutate({
              key: "backlog.default-state-filter" as never,
              value: e.target.value,
            })
          }
          wrapperClassName="max-w-[10rem]"
        >
          <option value="all">All</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="done">Done</option>
        </SelectField>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <span className="text-sm font-medium text-fg">Backlog — row density</span>
        <p className="text-xs text-fg-muted">
          Compact packs more rows on screen; cozy is the default touch-friendly height.
        </p>
        <SelectField
          value={backlogDensity}
          disabled={update.isPending || list.isPending}
          onChange={(e) =>
            update.mutate({
              key: "backlog.density" as never,
              value: e.target.value,
            })
          }
          wrapperClassName="max-w-[10rem]"
        >
          <option value="cozy">Cozy</option>
          <option value="compact">Compact</option>
        </SelectField>
      </div>

      <TimezoneField
        value={timezone}
        disabled={update.isPending || list.isPending}
        onCommit={(next) =>
          update.mutate({
            key: "display.timezone" as never,
            value: next,
          })
        }
      />

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <span className="text-sm font-medium text-fg">Auto-refresh interval (seconds)</span>
        <p className="text-xs text-fg-muted">
          How often list views (LLM providers, OAuth providers, and similar dashboards) silently
          re-fetch in the background. 0 disables auto-refresh; manual refetches still work. Maximum
          3600 (one hour).
        </p>
        <Input
          type="number"
          min={0}
          max={3600}
          step={1}
          value={autoRefresh}
          disabled={update.isPending || list.isPending}
          onChange={(e) => {
            const next = Number.parseInt(e.target.value, 10);
            if (!Number.isFinite(next) || next < 0) return;
            update.mutate({
              key: "ui.auto-refresh-seconds" as never,
              value: next,
            });
          }}
          className={`${fieldClass} max-w-[8rem]`}
        />
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <span className="text-sm font-medium text-fg">Chat — send on Enter</span>
        <p className="text-xs text-fg-muted">
          When on, Enter sends a message and Shift+Enter inserts a newline. When off, Enter inserts
          a newline and Cmd/Ctrl+Enter sends.
        </p>
        <Field className="inline-flex items-center gap-2 text-sm text-fg">
          <Switch
            checked={sendOnEnter === true}
            disabled={update.isPending || list.isPending}
            onChange={(next) =>
              update.mutate({
                key: "chat.send-on-enter" as never,
                value: next,
              })
            }
            className={switchTrackClass}
          >
            <span aria-hidden className={switchThumbClass} />
          </Switch>
          <Label>Enabled</Label>
        </Field>
        {update.error ? <p className="text-xs text-danger-fg">{update.error.message}</p> : null}
      </div>
    </div>
  );
}

function TimezoneField({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the persisted value changes (e.g. after a mutation invalidates).
  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-6">
      <span className="text-sm font-medium text-fg">Display time zone</span>
      <p className="text-xs text-fg-muted">
        IANA name used for relative dates and the staleness tint window (e.g.{" "}
        <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">Europe/Stockholm</code>,{" "}
        <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">UTC</code>). Empty falls back
        to the browser's local zone.
      </p>
      <Input
        type="text"
        placeholder="(browser local)"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          const next = e.target.value.trim();
          if (next === value) {
            setDraft(value);
            setError(null);
            return;
          }
          if (next !== "") {
            try {
              Intl.DateTimeFormat(undefined, { timeZone: next });
            } catch {
              setError(`'${next}' is not a recognized IANA time zone`);
              return;
            }
          }
          setError(null);
          setDraft(next);
          onCommit(next);
        }}
        className={`${fieldClass} max-w-md`}
      />
      {error ? <p className="text-xs text-danger-fg">{error}</p> : null}
    </div>
  );
}
