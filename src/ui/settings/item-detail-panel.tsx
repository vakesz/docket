"use client";

import { Field, Input, Label, Switch } from "@headlessui/react";
import { AlertTriangle } from "lucide-react";
import { fieldClass, switchThumbClass, switchTrackClass } from "@/lib/form-classes";
import { DEFAULT_STALE_THRESHOLD_DAYS } from "@/lib/staleness";
import { trpc } from "@/lib/trpc-client";

const USER_OVERRIDE_KEY = "items.stale-after-days.user";

/**
 * Item detail section — per-user knobs for what shows on the item detail
 * page. Currently exposes the personal staleness override; toggling it on
 * lifts the user out of the project-level default and applies the same
 * threshold across every project they view.
 */
export function ItemDetailPanel({ projectId }: { projectId: string | null }) {
  const utils = trpc.useUtils();
  const userList = trpc.settings.list.useQuery();
  const projectList = trpc.settings.projectList.useQuery(
    { projectId: projectId ?? "" },
    { enabled: projectId !== null },
  );

  const update = trpc.settings.update.useMutation({
    onSuccess: async () => {
      await utils.settings.list.invalidate();
    },
  });

  const userValueRaw = userList.data?.find((r) => r.key === USER_OVERRIDE_KEY)?.value;
  const userValue = typeof userValueRaw === "number" ? userValueRaw : -1;
  const overrideOn = userValue >= 0;
  const indicatorOn = userValue > 0;

  const projectValueRaw = projectList.data?.find((r) => r.key === "items.stale-after-days")?.value;
  const projectValue = typeof projectValueRaw === "number" ? projectValueRaw : null;
  const projectThresholdLabel =
    projectValue === null
      ? "(no project selected)"
      : projectValue === 0
        ? "Disabled"
        : `${projectValue} day${projectValue === 1 ? "" : "s"}`;

  const disabled = userList.isPending || update.isPending;

  const onToggleOverride = (next: boolean) => {
    update.mutate({
      key: USER_OVERRIDE_KEY as never,
      value: next ? DEFAULT_STALE_THRESHOLD_DAYS : -1,
    });
  };

  const onToggleIndicator = (next: boolean) => {
    update.mutate({
      key: USER_OVERRIDE_KEY as never,
      value: next ? DEFAULT_STALE_THRESHOLD_DAYS : 0,
    });
  };

  const onChangeThreshold = (next: number) => {
    if (!Number.isFinite(next) || next < 1) return;
    update.mutate({
      key: USER_OVERRIDE_KEY as never,
      value: Math.min(Math.trunc(next), 3650),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-fg">Staleness indicator</h3>
          <p className="text-xs text-fg-muted">
            Backlog rows tint amber once an item has been untouched past the threshold, and red at
            2x. The detail-page header shows the same age stamp. Project default:{" "}
            <span className="font-medium text-fg">{projectThresholdLabel}</span>.
          </p>
        </header>

        <Field className="flex flex-col gap-1">
          <Field className="flex items-center gap-2 text-sm text-fg">
            <Switch
              checked={overrideOn}
              disabled={disabled}
              onChange={onToggleOverride}
              className={switchTrackClass}
            >
              <span aria-hidden className={switchThumbClass} />
            </Switch>
            <Label>{overrideOn ? "Using my own threshold" : "Inheriting project default"}</Label>
          </Field>
          {overrideOn ? (
            <p className="inline-flex items-start gap-1.5 text-xs text-warning-fg">
              <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
              <span>
                Not recommended — your override replaces the project default for every project you
                view. Leave this off so each project's threshold applies.
              </span>
            </p>
          ) : (
            <p className="text-xs text-fg-muted">
              Off by default. Turn on only if you want a different freshness window than your
              projects use.
            </p>
          )}
        </Field>

        {overrideOn ? (
          <Field className="flex flex-col gap-1">
            <Label className="text-sm font-medium text-fg">Show staleness indicator (mine)</Label>
            <p className="text-xs text-fg-muted">
              When off, the freshness tint and detail-page age badge are hidden for me on every
              project — even if a project's own default is positive.
            </p>
            <Field className="flex items-center gap-2 text-sm text-fg">
              <Switch
                checked={indicatorOn}
                disabled={disabled}
                onChange={onToggleIndicator}
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
            <Label className="text-sm font-medium text-fg">My threshold (days)</Label>
            <p className="text-xs text-fg-muted">
              Days an item can sit untouched before it tints amber. Range: 1 to 3650.
            </p>
            <Input
              type="number"
              min={1}
              max={3650}
              step={1}
              value={userValue > 0 ? userValue : DEFAULT_STALE_THRESHOLD_DAYS}
              disabled={disabled}
              onChange={(e) => onChangeThreshold(Number.parseInt(e.target.value, 10))}
              className={`${fieldClass} max-w-[8rem]`}
            />
          </Field>
        ) : null}
      </section>

      {update.error ? <p className="text-xs text-danger-fg">{update.error.message}</p> : null}
    </div>
  );
}
