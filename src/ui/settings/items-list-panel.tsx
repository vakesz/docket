"use client";

import { AlertTriangle } from "lucide-react";
import { useId } from "react";
import { useProjectSettingsMap, useSettingsMap } from "@/lib/settings-client";
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
  const settings = useSettingsMap();
  const projectSettings = useProjectSettingsMap({ projectSlug });
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

  const maxVisibleTags = settings.num("items.max-visible-tags", 2);
  const maxVisibleAssignees = settings.num("items.max-visible-assignees", 2);
  const assigneeSelectorStyle: "chips" | "dropdown" =
    settings.str("items.assignee-selector-style", "chips") === "dropdown" ? "dropdown" : "chips";
  const showAvatars = settings.bool("items.show-assignee-avatars", true);
  const showArchivedBucket = settings.bool("items.show-archived-bucket", true);
  const backlogSort = settings.str("backlog.default-sort", "updated");
  const backlogState = settings.str("backlog.default-state-filter", "open");
  const backlogDensity = settings.str("backlog.density", "cozy");

  const userStale = settings.num(USER_STALE_OVERRIDE_KEY, -1);
  const overrideOn = userStale >= 0;
  const indicatorOn = userStale > 0;

  const projectStaleRaw = projectSettings.raw("items.stale-after-days");
  const projectStale = typeof projectStaleRaw === "number" ? projectStaleRaw : null;
  const projectThresholdLabel =
    projectStale === null
      ? "(no project selected)"
      : projectStale === 0
        ? "Disabled"
        : `${projectStale} day${projectStale === 1 ? "" : "s"}`;

  const disabled = settings.list.isPending || update.isPending;

  const onToggleStaleOverride = (next: boolean) => {
    update.mutate({
      key: USER_STALE_OVERRIDE_KEY,
      value: next ? DEFAULT_STALE_THRESHOLD_DAYS : -1,
    });
  };

  const onToggleStaleIndicator = (next: boolean) => {
    update.mutate({
      key: USER_STALE_OVERRIDE_KEY,
      value: next ? DEFAULT_STALE_THRESHOLD_DAYS : 0,
    });
  };

  const onChangeStaleThreshold = (next: number) => {
    if (!Number.isFinite(next) || next < 1) return;
    update.mutate({
      key: USER_STALE_OVERRIDE_KEY,
      value: Math.min(Math.trunc(next), 3650),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h3 className="font-medium text-foreground text-sm">Recently viewed</h3>
          <p className="text-muted-foreground text-xs">
            Pin recently-opened items to the top of the backlog so you can hop back without
            scrolling. Stored per-device — your other browsers won't see the same list.
          </p>
        </header>

        <div className="flex items-center gap-2 text-foreground text-sm">
          <Switch id={recentEnabledId} checked={recentEnabled} onCheckedChange={setRecentEnabled} />
          <Label htmlFor={recentEnabledId}>{recentEnabled ? "Visible" : "Hidden"}</Label>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={recentLimitId} className="font-medium text-foreground text-sm">
            Maximum recents to show
          </Label>
          <p className="text-muted-foreground text-xs">
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

      <section className="flex flex-col gap-4 border-border border-t pt-6">
        <header className="flex flex-col gap-1">
          <h3 className="font-medium text-foreground text-sm">Filter bar defaults</h3>
          <p className="text-muted-foreground text-xs">
            Initial sort, state bucket, and assignee/tag chip behavior on the backlog filter bar.
          </p>
        </header>

        <div className="flex flex-col gap-1">
          <Label htmlFor={sortId} className="font-medium text-foreground text-sm">
            Default sort
          </Label>
          <p className="text-muted-foreground text-xs">
            Sort order applied when a project's backlog opens. Changing the sort on a saved view
            still wins for that view.
          </p>
          <Select
            value={backlogSort}
            disabled={disabled}
            onValueChange={(value) =>
              update.mutate({
                key: "backlog.default-sort",
                value: value as "updated" | "created" | "priority" | "title",
              })
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
          <Label htmlFor={stateId} className="font-medium text-foreground text-sm">
            Default state filter
          </Label>
          <p className="text-muted-foreground text-xs">
            Initial state bucket applied when the backlog opens.
          </p>
          <Select
            value={backlogState}
            disabled={disabled}
            onValueChange={(value) =>
              update.mutate({
                key: "backlog.default-state-filter",
                value: value as "all" | "open" | "in_progress" | "done",
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
          <Label className="font-medium text-foreground text-sm">Show Archived bucket</Label>
          <p className="text-muted-foreground text-xs">
            When on, the filter bar offers an Archived bucket alongside Open / Closed / All.
            Archived rows remain reachable via the All-states bucket either way.
          </p>
          <div className="flex items-center gap-2 text-foreground text-sm">
            <Switch
              id={archivedId}
              checked={showArchivedBucket}
              disabled={disabled}
              onCheckedChange={(next) =>
                update.mutate({ key: "items.show-archived-bucket", value: next })
              }
            />
            <Label htmlFor={archivedId}>{showArchivedBucket ? "Visible" : "Hidden"}</Label>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={assigneeStyleId} className="font-medium text-foreground text-sm">
            Assignee selector style
          </Label>
          <p className="text-muted-foreground text-xs">
            Chips show each assignee as a toggleable pill — good for small teams. Dropdown is a
            multi-select list — switch when the project has many people and chips would overflow.
          </p>
          <Select
            value={assigneeSelectorStyle}
            disabled={disabled}
            onValueChange={(value) =>
              update.mutate({
                key: "items.assignee-selector-style",
                value: value as "chips" | "dropdown",
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
          <Label className="font-medium text-foreground text-sm">Show assignee avatars</Label>
          <p className="text-muted-foreground text-xs">
            When on, assignee chips render with the user's profile picture pulled from the provider.
            Currently GitHub-only — a deterministic CDN URL, no extra API calls. Other providers
            fall back to a colored initial circle. Turn off to show only the username.
          </p>
          <div className="flex items-center gap-2 text-foreground text-sm">
            <Switch
              id={showAvatarsId}
              checked={showAvatars}
              disabled={disabled}
              onCheckedChange={(next) =>
                update.mutate({ key: "items.show-assignee-avatars", value: next })
              }
            />
            <Label htmlFor={showAvatarsId}>{showAvatars ? "Visible" : "Hidden"}</Label>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={maxTagsId} className="font-medium text-foreground text-sm">
            Max tag chips shown
          </Label>
          <p className="text-muted-foreground text-xs">
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
            onCommit={(next) => update.mutate({ key: "items.max-visible-tags", value: next })}
            className="max-w-[6rem]"
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={maxAssigneesId} className="font-medium text-foreground text-sm">
            Max assignee chips shown
          </Label>
          <p className="text-muted-foreground text-xs">
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
            onCommit={(next) => update.mutate({ key: "items.max-visible-assignees", value: next })}
            className="max-w-[6rem]"
          />
        </div>
      </section>

      <section className="flex flex-col gap-4 border-border border-t pt-6">
        <header className="flex flex-col gap-1">
          <h3 className="font-medium text-foreground text-sm">Row appearance</h3>
          <p className="text-muted-foreground text-xs">
            How tightly packed each backlog row renders.
          </p>
        </header>

        <div className="flex flex-col gap-1">
          <Label htmlFor={densityId} className="font-medium text-foreground text-sm">
            Row density
          </Label>
          <p className="text-muted-foreground text-xs">
            Compact packs more rows on screen with smaller padding; cozy is the default
            touch-friendly height.
          </p>
          <Select
            value={backlogDensity}
            disabled={disabled}
            onValueChange={(value) =>
              update.mutate({ key: "backlog.density", value: value as "cozy" | "compact" })
            }
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

      <section className="flex flex-col gap-3 border-border border-t pt-6">
        <header className="flex flex-col gap-1">
          <h3 className="font-medium text-foreground text-sm">Staleness indicator</h3>
          <p className="text-muted-foreground text-xs">
            Backlog rows tint amber once an item has been untouched past the threshold, and red at
            2x. The detail-page header shows the same age stamp. Project default:{" "}
            <span className="font-medium text-foreground">{projectThresholdLabel}</span>.
          </p>
        </header>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-foreground text-sm">
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
            <p className="inline-flex items-start gap-1.5 text-primary text-xs">
              <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
              <span>
                Not recommended — your override replaces the project default for every project you
                view. Leave this off so each project's threshold applies.
              </span>
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">
              Off by default. Turn on only if you want a different freshness window than your
              projects use.
            </p>
          )}
        </div>

        {overrideOn ? (
          <div className="flex flex-col gap-1">
            <Label className="font-medium text-foreground text-sm">
              Show staleness indicator (mine)
            </Label>
            <p className="text-muted-foreground text-xs">
              When off, the freshness tint and detail-page age badge are hidden for me on every
              project — even if a project's own default is positive.
            </p>
            <div className="flex items-center gap-2 text-foreground text-sm">
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
            <Label htmlFor={thresholdId} className="font-medium text-foreground text-sm">
              My threshold (days)
            </Label>
            <p className="text-muted-foreground text-xs">
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
