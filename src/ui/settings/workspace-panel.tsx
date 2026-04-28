"use client";
import { fieldClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { Toggle } from "@/ui/primitives/toggle";

/**
 * Deployment-wide knobs that aren't tied to a specific provider row.
 * Two settings live here today:
 *
 *  - `items.stale-after-days` — backlog freshness tint threshold.
 *  - `app.read-only` — kill-switch for every mutation route.
 *
 * Both are sourced from the typed catalog (`@/server/settings/catalog`)
 * via the new `globalList` / `globalUpdate` endpoints, so the panel
 * doesn't have to hard-code labels or descriptions.
 */
export function WorkspacePanel() {
  const utils = trpc.useUtils();
  const list = trpc.settings.globalList.useQuery();
  const update = trpc.settings.globalUpdate.useMutation({
    onSuccess: async () => {
      await utils.settings.globalList.invalidate();
    },
  });

  const stale = list.data?.find((r) => r.key === "items.stale-after-days");
  const readOnly = list.data?.find((r) => r.key === "app.read-only");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-fg">
          {stale?.label ?? "Stale-after threshold (days)"}
        </span>
        <p className="text-xs text-fg-muted">
          {stale?.description ??
            "Backlog rows tint amber once an item has been untouched this long, and red at 2x. Set to 0 to disable the freshness tint entirely."}
        </p>
        <input
          type="number"
          min={0}
          max={3650}
          step={1}
          value={typeof stale?.value === "number" ? stale.value : 7}
          disabled={list.isPending || update.isPending}
          onChange={(e) => {
            const next = Number.parseInt(e.target.value, 10);
            if (!Number.isFinite(next) || next < 0) return;
            update.mutate({
              key: "items.stale-after-days" as never,
              value: next,
            });
          }}
          className={`${fieldClass} max-w-[8rem]`}
        />
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <span className="text-sm font-medium text-fg">
          {readOnly?.label ?? "System read-only mode"}
        </span>
        <p className="text-xs text-fg-muted">
          {readOnly?.description ??
            "When on, every mutation route — including proposal confirms — is blocked. Reads stay open. Flip on for maintenance windows."}
        </p>
        <Toggle
          inline
          checked={readOnly?.value === true}
          disabled={list.isPending || update.isPending}
          onChange={(next) =>
            update.mutate({
              key: "app.read-only" as never,
              value: next,
            })
          }
          label={readOnly?.value === true ? "Enabled — all writes blocked" : "Disabled"}
        />
      </div>

      {update.error ? <p className="text-xs text-danger-fg">{update.error.message}</p> : null}
      {list.error ? <p className="text-xs text-danger-fg">{list.error.message}</p> : null}
    </div>
  );
}
