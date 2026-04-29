"use client";

import { Field, Label, Switch } from "@headlessui/react";
import { AlertTriangle } from "lucide-react";
import { switchThumbClass, switchTrackClass } from "@/lib/form-classes";
import { DEFAULT_STALE_THRESHOLD_DAYS } from "@/lib/staleness";
import { trpc } from "@/lib/trpc-client";
import { RECENT_LIMIT_MAX, useRecentEnabled, useRecentLimit } from "@/lib/ui-prefs";
import { NumberField } from "@/ui/forms/number-field";
import { SelectField } from "@/ui/forms/select-field";

const USER_STALE_OVERRIDE_KEY = "items.stale-after-days.user";

/**
 * Items list section — every backlog list / filter bar preference, both
 * catalog-backed and browser-local, in one place. Catalog-backed fields
 * persist server-side; browser-local fields (recents) live in localStorage
 * since the recent ids themselves are per-device.
 *
 * Hosts the personal staleness override (was under "Item detail" — moved
 * here because the freshness tint shows up on the backlog list, not on the
 * detail page header).
 */
export function ItemsListPanel({ projectId }: { projectId: string | null }) {
  const utils = trpc.useUtils();
  const list = trpc.settings.list.useQuery();
  const projectList = trpc.settings.projectList.useQuery(
    { projectId: projectId ?? "" },
    { enabled: projectId !== null },
  );
  const update = trpc.settings.update.useMutation({
    onSuccess: async () => {
      await utils.settings.list.invalidate();
    },
  });

  const [recentEnabled, setRecentEnabled] = useRecentEnabled();
  const [recentLimit, setRecentLimit] = useRecentLimit();

  const maxVisibleTagsRaw = list.data?.find((r) => r.key === "items.max-visible-tags")?.value;
  const maxVisibleTags = typeof maxVisibleTagsRaw === "number" ? maxVisibleTagsRaw : 2;
  const maxVisibleAssigneesRaw = list.data?.find(
    (r) => r.key === "items.max-visible-assignees",
  )?.value;
  const maxVisibleAssignees =
    typeof maxVisibleAssigneesRaw === "number" ? maxVisibleAssigneesRaw : 2;
  const assigneeSelectorStyleRaw = list.data?.find(
    (r) => r.key === "items.assignee-selector-style",
  )?.value;
  const assigneeSelectorStyle: "chips" | "dropdown" =
    assigneeSelectorStyleRaw === "dropdown" ? "dropdown" : "chips";
  const showAvatarsRaw = list.data?.find((r) => r.key === "items.show-assignee-avatars")?.value;
  const showAvatars = typeof showAvatarsRaw === "boolean" ? showAvatarsRaw : true;
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

  const userStaleRaw = list.data?.find((r) => r.key === USER_STALE_OVERRIDE_KEY)?.value;
  const userStale = typeof userStaleRaw === "number" ? userStaleRaw : -1;
  const overrideOn = userStale >= 0;
  const indicatorOn = userStale > 0;

  const projectStaleRaw = projectList.data?.find((r) => r.key === "items.stale-after-days")?.value;
  const projectStale = typeof projectStaleRaw === "number" ? projectStaleRaw : null;
  const projectThresholdLabel =
    projectStale === null
      ? "(no project selected)"
      : projectStale === 0
        ? "Disabled"
        : `${projectStale} day${projectStale === 1 ? "" : "s"}`;

  const disabled = list.isPending || update.isPending;

  const onToggleStaleOverride = (next: boolean) => {
    update.mutate({
      key: USER_STALE_OVERRIDE_KEY as never,
      value: next ? DEFAULT_STALE_THRESHOLD_DAYS : -1,
    });
  };

  const onToggleStaleIndicator = (next: boolean) => {
    update.mutate({
      key: USER_STALE_OVERRIDE_KEY as never,
      value: next ? DEFAULT_STALE_THRESHOLD_DAYS : 0,
    });
  };

  const onChangeStaleThreshold = (next: number) => {
    if (!Number.isFinite(next) || next < 1) return;
    update.mutate({
      key: USER_STALE_OVERRIDE_KEY as never,
      value: Math.min(Math.trunc(next), 3650),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-foreground">Recently viewed</h3>
          <p className="text-xs text-muted-foreground">
            Pin recently-opened items to the top of the backlog so you can hop back without
            scrolling. Stored per-device — your other browsers won't see the same list.
          </p>
        </header>

        <Field className="flex items-center gap-2 text-sm text-foreground">
          <Switch checked={recentEnabled} onChange={setRecentEnabled} className={switchTrackClass}>
            <span aria-hidden className={switchThumbClass} />
          </Switch>
          <Label>{recentEnabled ? "Visible" : "Hidden"}</Label>
        </Field>

        <Field className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">Maximum recents to show</Label>
          <p className="text-xs text-muted-foreground">
            How many rows the Recent strip shows above the backlog. Maximum {RECENT_LIMIT_MAX}; set
            to 0 to hide the strip entirely.
          </p>
          <NumberField
            min={0}
            max={RECENT_LIMIT_MAX}
            step={1}
            value={recentLimit}
            disabled={!recentEnabled}
            onCommit={setRecentLimit}
            className="max-w-[6rem]"
          />
        </Field>
      </section>

      <section className="flex flex-col gap-4 border-t border-border pt-6">
        <header className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-foreground">Filter bar defaults</h3>
          <p className="text-xs text-muted-foreground">
            Initial sort, state bucket, and assignee/tag chip behavior on the backlog filter bar.
          </p>
        </header>

        <Field className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">Default sort</Label>
          <p className="text-xs text-muted-foreground">
            Sort order applied when a project's backlog opens. Changing the sort on a saved view
            still wins for that view.
          </p>
          <SelectField
            value={backlogSort}
            disabled={disabled}
            onChange={(e) =>
              update.mutate({ key: "backlog.default-sort" as never, value: e.target.value })
            }
            wrapperClassName="max-w-[10rem]"
          >
            <option value="updated">Updated</option>
            <option value="created">Created</option>
            <option value="priority">Priority</option>
            <option value="title">Title</option>
          </SelectField>
        </Field>

        <Field className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">Default state filter</Label>
          <p className="text-xs text-muted-foreground">
            Initial state bucket applied when the backlog opens.
          </p>
          <SelectField
            value={backlogState}
            disabled={disabled}
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
        </Field>

        <Field className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">Show Archived bucket</Label>
          <p className="text-xs text-muted-foreground">
            When on, the filter bar offers an Archived bucket alongside Open / Closed / All.
            Archived rows remain reachable via the All-states bucket either way.
          </p>
          <Field className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              checked={showArchivedBucket}
              disabled={disabled}
              onChange={(next) =>
                update.mutate({ key: "items.show-archived-bucket" as never, value: next })
              }
              className={switchTrackClass}
            >
              <span aria-hidden className={switchThumbClass} />
            </Switch>
            <Label>{showArchivedBucket ? "Visible" : "Hidden"}</Label>
          </Field>
        </Field>

        <Field className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">Assignee selector style</Label>
          <p className="text-xs text-muted-foreground">
            Chips show each assignee as a toggleable pill — good for small teams. Dropdown is a
            multi-select list — switch when the project has many people and chips would overflow.
          </p>
          <SelectField
            value={assigneeSelectorStyle}
            disabled={disabled}
            onChange={(e) =>
              update.mutate({
                key: "items.assignee-selector-style" as never,
                value: e.target.value,
              })
            }
            wrapperClassName="max-w-[10rem]"
          >
            <option value="chips">Chips</option>
            <option value="dropdown">Dropdown</option>
          </SelectField>
        </Field>

        <Field className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">Show assignee avatars</Label>
          <p className="text-xs text-muted-foreground">
            When on, assignee chips render with the user's profile picture pulled from the provider.
            Currently GitHub-only — a deterministic CDN URL, no extra API calls. Other providers
            fall back to a colored initial circle. Turn off to show only the username.
          </p>
          <Field className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              checked={showAvatars}
              disabled={disabled}
              onChange={(next) =>
                update.mutate({ key: "items.show-assignee-avatars" as never, value: next })
              }
              className={switchTrackClass}
            >
              <span aria-hidden className={switchThumbClass} />
            </Switch>
            <Label>{showAvatars ? "Visible" : "Hidden"}</Label>
          </Field>
        </Field>

        <Field className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">Max tag chips shown</Label>
          <p className="text-xs text-muted-foreground">
            How many tag chips render inline (on each backlog row, and in the tag-filter bar at the
            top of the backlog) before the rest collapse into a +N badge. Set to 0 to always
            collapse.
          </p>
          <NumberField
            min={0}
            max={20}
            step={1}
            value={maxVisibleTags}
            disabled={disabled}
            onCommit={(next) =>
              update.mutate({ key: "items.max-visible-tags" as never, value: next })
            }
            className="max-w-[6rem]"
          />
        </Field>

        <Field className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">Max assignee chips shown</Label>
          <p className="text-xs text-muted-foreground">
            How many assignee chips render in the filter row before the rest collapse into a +N
            badge. Only applies when the assignee selector style is set to chips. Set to 0 to always
            collapse.
          </p>
          <NumberField
            min={0}
            max={20}
            step={1}
            value={maxVisibleAssignees}
            disabled={disabled || assigneeSelectorStyle !== "chips"}
            onCommit={(next) =>
              update.mutate({ key: "items.max-visible-assignees" as never, value: next })
            }
            className="max-w-[6rem]"
          />
        </Field>
      </section>

      <section className="flex flex-col gap-4 border-t border-border pt-6">
        <header className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-foreground">Row appearance</h3>
          <p className="text-xs text-muted-foreground">
            How tightly packed each backlog row renders.
          </p>
        </header>

        <Field className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">Row density</Label>
          <p className="text-xs text-muted-foreground">
            Compact packs more rows on screen with smaller padding; cozy is the default
            touch-friendly height.
          </p>
          <SelectField
            value={backlogDensity}
            disabled={disabled}
            onChange={(e) =>
              update.mutate({ key: "backlog.density" as never, value: e.target.value })
            }
            wrapperClassName="max-w-[10rem]"
          >
            <option value="cozy">Cozy</option>
            <option value="compact">Compact</option>
          </SelectField>
        </Field>
      </section>

      <section className="flex flex-col gap-3 border-t border-border pt-6">
        <header className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-foreground">Staleness indicator</h3>
          <p className="text-xs text-muted-foreground">
            Backlog rows tint amber once an item has been untouched past the threshold, and red at
            2x. The detail-page header shows the same age stamp. Project default:{" "}
            <span className="font-medium text-foreground">{projectThresholdLabel}</span>.
          </p>
        </header>

        <Field className="flex flex-col gap-1">
          <Field className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              checked={overrideOn}
              disabled={disabled}
              onChange={onToggleStaleOverride}
              className={switchTrackClass}
            >
              <span aria-hidden className={switchThumbClass} />
            </Switch>
            <Label>{overrideOn ? "Using my own threshold" : "Inheriting project default"}</Label>
          </Field>
          {overrideOn ? (
            <p className="inline-flex items-start gap-1.5 text-xs text-warning">
              <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
              <span>
                Not recommended — your override replaces the project default for every project you
                view. Leave this off so each project's threshold applies.
              </span>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Off by default. Turn on only if you want a different freshness window than your
              projects use.
            </p>
          )}
        </Field>

        {overrideOn ? (
          <Field className="flex flex-col gap-1">
            <Label className="text-sm font-medium text-foreground">
              Show staleness indicator (mine)
            </Label>
            <p className="text-xs text-muted-foreground">
              When off, the freshness tint and detail-page age badge are hidden for me on every
              project — even if a project's own default is positive.
            </p>
            <Field className="flex items-center gap-2 text-sm text-foreground">
              <Switch
                checked={indicatorOn}
                disabled={disabled}
                onChange={onToggleStaleIndicator}
                className={switchTrackClass}
              >
                <span aria-hidden className={switchThumbClass} />
              </Switch>
              <Label>{indicatorOn ? "Visible" : "Hidden"}</Label>
            </Field>
          </Field>
        ) : null}

        {overrideOn && indicatorOn ? (
          <Field className="flex flex-col gap-1">
            <Label className="text-sm font-medium text-foreground">My threshold (days)</Label>
            <p className="text-xs text-muted-foreground">
              Days an item can sit untouched before it tints amber. Range: 1 to 3650.
            </p>
            <NumberField
              min={1}
              max={3650}
              step={1}
              value={userStale > 0 ? userStale : DEFAULT_STALE_THRESHOLD_DAYS}
              disabled={disabled}
              onCommit={onChangeStaleThreshold}
              className="max-w-[8rem]"
            />
          </Field>
        ) : null}
      </section>

      {update.error ? <p className="text-xs text-destructive">{update.error.message}</p> : null}
    </div>
  );
}
