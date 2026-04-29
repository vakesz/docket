"use client";

import { useId, useState } from "react";
import { DEFAULT_STALE_THRESHOLD_DAYS } from "@/lib/staleness";
import { trpc } from "@/lib/trpc-client";
import { NumberField } from "@/ui/forms/number-field";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Label } from "@/ui/primitives/label";
import { Switch } from "@/ui/primitives/switch";

const STALE_KEY = "items.stale-after-days";

/**
 * Project-level defaults for the items list — currently the staleness
 * threshold. Each member sees this value unless they set their own
 * override under Profile → Item detail.
 */
export function ProjectItemsPanel({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const list = trpc.settings.projectList.useQuery({ projectId });
  const update = trpc.settings.projectUpdate.useMutation({
    onSuccess: async () => {
      await utils.settings.projectList.invalidate({ projectId });
    },
  });

  const valueRaw = list.data?.find((r) => r.key === STALE_KEY)?.value;
  const value = typeof valueRaw === "number" ? valueRaw : DEFAULT_STALE_THRESHOLD_DAYS;
  const indicatorOn = value > 0;
  const [lastPositive, setLastPositive] = useState<number>(
    value > 0 ? value : DEFAULT_STALE_THRESHOLD_DAYS,
  );
  const disabled = list.isPending || update.isPending;
  const indicatorId = useId();
  const thresholdId = useId();

  const onToggleIndicator = (next: boolean) => {
    update.mutate({
      projectId,
      key: STALE_KEY as never,
      value: next ? lastPositive : 0,
    });
  };

  const onChangeThreshold = (next: number) => {
    if (!Number.isFinite(next) || next < 1) return;
    const clamped = Math.min(Math.trunc(next), 3650);
    setLastPositive(clamped);
    update.mutate({ projectId, key: STALE_KEY as never, value: clamped });
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-foreground">
            Staleness threshold (project default)
          </h3>
          <p className="text-xs text-muted-foreground">
            Backlog rows tint amber once an item has been untouched for this many days, and red at
            2x. Each project member sees this value by default; they can override it under Profile →
            Item detail.
          </p>
        </header>

        <div className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">Show staleness indicator</Label>
          <p className="text-xs text-muted-foreground">
            When off, the freshness tint and detail-page age badge are hidden for everyone viewing
            this project (members with their own override still see their value).
          </p>
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              id={indicatorId}
              checked={indicatorOn}
              disabled={disabled}
              onCheckedChange={onToggleIndicator}
            />
            <Label htmlFor={indicatorId}>{indicatorOn ? "Visible" : "Hidden"}</Label>
          </div>
        </div>

        {indicatorOn ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={thresholdId} className="text-sm font-medium text-foreground">
              Threshold (days)
            </Label>
            <p className="text-xs text-muted-foreground">
              Days an item can sit untouched before it tints amber. Range: 1 to 3650.
            </p>
            <NumberField
              id={thresholdId}
              min={1}
              max={3650}
              step={1}
              value={value > 0 ? value : lastPositive}
              disabled={disabled}
              onCommit={onChangeThreshold}
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
