"use client";

import { Field, Input, Label, Switch } from "@headlessui/react";
import { fieldClass, switchThumbClass, switchTrackClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { RECENT_LIMIT_MAX, useRecentEnabled, useRecentLimit } from "@/lib/ui-prefs";
import { SelectField } from "@/ui/forms/select-field";

/**
 * Items list section — every backlog list / filter bar preference, both
 * catalog-backed and browser-local, in one place. Catalog-backed fields
 * persist server-side; browser-local fields (recents) live in localStorage
 * since the recent ids themselves are per-device.
 */
export function ItemsListPanel() {
  const utils = trpc.useUtils();
  const list = trpc.settings.list.useQuery();
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

  const disabled = list.isPending || update.isPending;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-fg">Recently viewed</h3>
          <p className="text-xs text-fg-muted">
            Pin recently-opened items to the top of the backlog so you can hop back without
            scrolling. Stored per-device — your other browsers won't see the same list.
          </p>
        </header>

        <Field className="flex items-center gap-2 text-sm text-fg">
          <Switch checked={recentEnabled} onChange={setRecentEnabled} className={switchTrackClass}>
            <span aria-hidden className={switchThumbClass} />
          </Switch>
          <Label>{recentEnabled ? "Visible" : "Hidden"}</Label>
        </Field>

        <Field className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-fg">Maximum recents to show</Label>
          <p className="text-xs text-fg-muted">
            How many rows the Recent strip shows above the backlog. Maximum {RECENT_LIMIT_MAX}; set
            to 0 to hide the strip entirely.
          </p>
          <Input
            type="number"
            min={0}
            max={RECENT_LIMIT_MAX}
            step={1}
            value={recentLimit}
            disabled={!recentEnabled}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              if (!Number.isFinite(next) || next < 0) return;
              setRecentLimit(Math.min(next, RECENT_LIMIT_MAX));
            }}
            className={`${fieldClass} max-w-[6rem]`}
          />
        </Field>
      </section>

      <section className="flex flex-col gap-4 border-t border-border pt-6">
        <header className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-fg">Filter bar defaults</h3>
          <p className="text-xs text-fg-muted">
            Initial sort, state bucket, and assignee/tag chip behavior on the backlog filter bar.
          </p>
        </header>

        <Field className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-fg">Default sort</Label>
          <p className="text-xs text-fg-muted">
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
          <Label className="text-sm font-medium text-fg">Default state filter</Label>
          <p className="text-xs text-fg-muted">
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
          <Label className="text-sm font-medium text-fg">Show Archived bucket</Label>
          <p className="text-xs text-fg-muted">
            When on, the filter bar offers an Archived bucket alongside Open / Closed / All.
            Archived rows remain reachable via the All-states bucket either way.
          </p>
          <Field className="flex items-center gap-2 text-sm text-fg">
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
          <Label className="text-sm font-medium text-fg">Assignee selector style</Label>
          <p className="text-xs text-fg-muted">
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
          <Label className="text-sm font-medium text-fg">Show assignee avatars</Label>
          <p className="text-xs text-fg-muted">
            When on, assignee chips render with the user's profile picture pulled from the provider.
            Currently GitHub-only — a deterministic CDN URL, no extra API calls. Other providers
            fall back to a colored initial circle. Turn off to show only the username.
          </p>
          <Field className="flex items-center gap-2 text-sm text-fg">
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
          <Label className="text-sm font-medium text-fg">Max tag chips shown</Label>
          <p className="text-xs text-fg-muted">
            How many tag chips render inline (on each backlog row, and in the tag-filter bar at the
            top of the backlog) before the rest collapse into a +N badge. Set to 0 to always
            collapse.
          </p>
          <Input
            type="number"
            min={0}
            max={20}
            step={1}
            value={maxVisibleTags}
            disabled={disabled}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              if (!Number.isFinite(next) || next < 0) return;
              update.mutate({ key: "items.max-visible-tags" as never, value: next });
            }}
            className={`${fieldClass} max-w-[6rem]`}
          />
        </Field>

        <Field className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-fg">Max assignee chips shown</Label>
          <p className="text-xs text-fg-muted">
            How many assignee chips render in the filter row before the rest collapse into a +N
            badge. Only applies when the assignee selector style is set to chips. Set to 0 to always
            collapse.
          </p>
          <Input
            type="number"
            min={0}
            max={20}
            step={1}
            value={maxVisibleAssignees}
            disabled={disabled || assigneeSelectorStyle !== "chips"}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              if (!Number.isFinite(next) || next < 0) return;
              update.mutate({ key: "items.max-visible-assignees" as never, value: next });
            }}
            className={`${fieldClass} max-w-[6rem]`}
          />
        </Field>
      </section>

      <section className="flex flex-col gap-4 border-t border-border pt-6">
        <header className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-fg">Row appearance</h3>
          <p className="text-xs text-fg-muted">How tightly packed each backlog row renders.</p>
        </header>

        <Field className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-fg">Row density</Label>
          <p className="text-xs text-fg-muted">
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

      {update.error ? <p className="text-xs text-danger-fg">{update.error.message}</p> : null}
    </div>
  );
}
