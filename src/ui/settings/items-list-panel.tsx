"use client";

import { AlertTriangle } from "lucide-react";
import { useId } from "react";
import { DEFAULT_STALE_THRESHOLD_DAYS } from "@/lib/staleness";
import { trpc } from "@/lib/trpc-client";
import { RECENT_LIMIT_MAX, useRecentEnabled, useRecentLimit } from "@/lib/ui-prefs";
import { NumberField } from "@/ui/forms/number-field";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Label } from "@/ui/primitives/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";
import { Switch } from "@/ui/primitives/switch";

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
export function ItemsListPanel({ projectSlug }: { projectSlug: string | null }) {
  const utils = trpc.useUtils();
  const list = trpc.settings.list.useQuery();
  const projectList = trpc.settings.projectList.useQuery(
    { projectSlug: projectSlug ?? "" },
    { enabled: projectSlug !== null },
  );
  const update = trpc.settings.update.useMutation({
    onSuccess: async () => {
      await utils.settings.list.invalidate();
    },
  });

  const [recentEnabled, setRecentEnabled] = useRecentEnabled();
  const [recentLimit, setRecentLimit] = useRecentLimit();

  const recentEnabledId = useId();
  const recentLimitId = useId();
  const sortId = useId();
  const stateId = useId();
  const archivedId = useId();
  const assigneeStyleId = useId();
  const showAvatarsId = useId();
  const maxTagsId = useId();
  const maxAssigneesId = useId();
  const densityId = useId();
  const overrideId = useId();
  const indicatorId = useId();
  const thresholdId = useId();

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

        <div className="flex items-center gap-2 text-sm text-foreground">
          <Switch id={recentEnabledId} checked={recentEnabled} onCheckedChange={setRecentEnabled} />
          <Label htmlFor={recentEnabledId}>{recentEnabled ? "Visible" : "Hidden"}</Label>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={recentLimitId} className="text-sm font-medium text-foreground">
            Maximum recents to show
          </Label>
          <p className="text-xs text-muted-foreground">
            How many rows the Recent strip shows above the backlog. Maximum {RECENT_LIMIT_MAX}; set
            to 0 to hide the strip entirely.
          </p>
          <NumberField
            id={recentLimitId}
            min={0}
            max={RECENT_LIMIT_MAX}
            step={1}
            value={recentLimit}
            disabled={!recentEnabled}
            onCommit={setRecentLimit}
            className="max-w-[6rem]"
          />
        </div>
      </section>

      <section className="flex flex-col gap-4 border-t border-border pt-6">
        <header className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-foreground">Filter bar defaults</h3>
          <p className="text-xs text-muted-foreground">
            Initial sort, state bucket, and assignee/tag chip behavior on the backlog filter bar.
          </p>
        </header>

        <div className="flex flex-col gap-1">
          <Label htmlFor={sortId} className="text-sm font-medium text-foreground">
            Default sort
          </Label>
          <p className="text-xs text-muted-foreground">
            Sort order applied when a project's backlog opens. Changing the sort on a saved view
            still wins for that view.
          </p>
          <Select
            value={backlogSort}
            disabled={disabled}
            onValueChange={(value) =>
              update.mutate({ key: "backlog.default-sort" as never, value })
            }
          >
            <SelectTrigger id={sortId} className="max-w-[10rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updated">Updated</SelectItem>
              <SelectItem value="created">Created</SelectItem>
              <SelectItem value="priority">Priority</SelectItem>
              <SelectItem value="title">Title</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={stateId} className="text-sm font-medium text-foreground">
            Default state filter
          </Label>
          <p className="text-xs text-muted-foreground">
            Initial state bucket applied when the backlog opens.
          </p>
          <Select
            value={backlogState}
            disabled={disabled}
            onValueChange={(value) =>
              update.mutate({
                key: "backlog.default-state-filter" as never,
                value,
              })
            }
          >
            <SelectTrigger id={stateId} className="max-w-[10rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="in_progress">In progress</SelectItem>
              <SelectItem value="done">Done</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">Show Archived bucket</Label>
          <p className="text-xs text-muted-foreground">
            When on, the filter bar offers an Archived bucket alongside Open / Closed / All.
            Archived rows remain reachable via the All-states bucket either way.
          </p>
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              id={archivedId}
              checked={showArchivedBucket}
              disabled={disabled}
              onCheckedChange={(next) =>
                update.mutate({ key: "items.show-archived-bucket" as never, value: next })
              }
            />
            <Label htmlFor={archivedId}>{showArchivedBucket ? "Visible" : "Hidden"}</Label>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={assigneeStyleId} className="text-sm font-medium text-foreground">
            Assignee selector style
          </Label>
          <p className="text-xs text-muted-foreground">
            Chips show each assignee as a toggleable pill — good for small teams. Dropdown is a
            multi-select list — switch when the project has many people and chips would overflow.
          </p>
          <Select
            value={assigneeSelectorStyle}
            disabled={disabled}
            onValueChange={(value) =>
              update.mutate({
                key: "items.assignee-selector-style" as never,
                value,
              })
            }
          >
            <SelectTrigger id={assigneeStyleId} className="max-w-[10rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="chips">Chips</SelectItem>
              <SelectItem value="dropdown">Dropdown</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">Show assignee avatars</Label>
          <p className="text-xs text-muted-foreground">
            When on, assignee chips render with the user's profile picture pulled from the provider.
            Currently GitHub-only — a deterministic CDN URL, no extra API calls. Other providers
            fall back to a colored initial circle. Turn off to show only the username.
          </p>
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              id={showAvatarsId}
              checked={showAvatars}
              disabled={disabled}
              onCheckedChange={(next) =>
                update.mutate({ key: "items.show-assignee-avatars" as never, value: next })
              }
            />
            <Label htmlFor={showAvatarsId}>{showAvatars ? "Visible" : "Hidden"}</Label>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={maxTagsId} className="text-sm font-medium text-foreground">
            Max tag chips shown
          </Label>
          <p className="text-xs text-muted-foreground">
            How many tag chips render inline (on each backlog row, and in the tag-filter bar at the
            top of the backlog) before the rest collapse into a +N badge. Set to 0 to always
            collapse.
          </p>
          <NumberField
            id={maxTagsId}
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
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={maxAssigneesId} className="text-sm font-medium text-foreground">
            Max assignee chips shown
          </Label>
          <p className="text-xs text-muted-foreground">
            How many assignee chips render in the filter row before the rest collapse into a +N
            badge. Only applies when the assignee selector style is set to chips. Set to 0 to always
            collapse.
          </p>
          <NumberField
            id={maxAssigneesId}
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
        </div>
      </section>

      <section className="flex flex-col gap-4 border-t border-border pt-6">
        <header className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-foreground">Row appearance</h3>
          <p className="text-xs text-muted-foreground">
            How tightly packed each backlog row renders.
          </p>
        </header>

        <div className="flex flex-col gap-1">
          <Label htmlFor={densityId} className="text-sm font-medium text-foreground">
            Row density
          </Label>
          <p className="text-xs text-muted-foreground">
            Compact packs more rows on screen with smaller padding; cozy is the default
            touch-friendly height.
          </p>
          <Select
            value={backlogDensity}
            disabled={disabled}
            onValueChange={(value) => update.mutate({ key: "backlog.density" as never, value })}
          >
            <SelectTrigger id={densityId} className="max-w-[10rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cozy">Cozy</SelectItem>
              <SelectItem value="compact">Compact</SelectItem>
            </SelectContent>
          </Select>
        </div>
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

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              id={overrideId}
              checked={overrideOn}
              disabled={disabled}
              onCheckedChange={onToggleStaleOverride}
            />
            <Label htmlFor={overrideId}>
              {overrideOn ? "Using my own threshold" : "Inheriting project default"}
            </Label>
          </div>
          {overrideOn ? (
            <p className="inline-flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
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
        </div>

        {overrideOn ? (
          <div className="flex flex-col gap-1">
            <Label className="text-sm font-medium text-foreground">
              Show staleness indicator (mine)
            </Label>
            <p className="text-xs text-muted-foreground">
              When off, the freshness tint and detail-page age badge are hidden for me on every
              project — even if a project's own default is positive.
            </p>
            <div className="flex items-center gap-2 text-sm text-foreground">
              <Switch
                id={indicatorId}
                checked={indicatorOn}
                disabled={disabled}
                onCheckedChange={onToggleStaleIndicator}
              />
              <Label htmlFor={indicatorId}>{indicatorOn ? "Visible" : "Hidden"}</Label>
            </div>
          </div>
        ) : null}

        {overrideOn && indicatorOn ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={thresholdId} className="text-sm font-medium text-foreground">
              My threshold (days)
            </Label>
            <p className="text-xs text-muted-foreground">
              Days an item can sit untouched before it tints amber. Range: 1 to 3650.
            </p>
            <NumberField
              id={thresholdId}
              min={1}
              max={3650}
              step={1}
              value={userStale > 0 ? userStale : DEFAULT_STALE_THRESHOLD_DAYS}
              disabled={disabled}
              onCommit={onChangeStaleThreshold}
              className="max-w-[8rem]"
            />
          </div>
        ) : null}
      </section>

      {update.error ? (
        <Alert variant="destructive">
          <AlertDescription>{update.error.message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
