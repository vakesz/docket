import { RefreshCw } from "lucide-react";

import { NumberInput } from "~/components/common/FormInputs";
import { Label } from "~/components/common/Label";
import { cn } from "~/lib/cn";

import { asRecord, getNumberValue } from "../_helpers";
import { FormField, NumberMapEditor } from "../_shared";
import type { ConfigMap } from "../_types";

export function SyncForm({
  initialConfig,
  value,
  onChange,
  onFullSync,
  fullSyncPending,
  fullSyncError,
}: {
  initialConfig: ConfigMap;
  value: ConfigMap;
  onChange: (updater: (current: ConfigMap) => ConfigMap) => void;
  onFullSync: () => void;
  fullSyncPending: boolean;
  fullSyncError: string | null;
}) {
  const interval = getNumberValue(value, "background_interval_seconds");
  const map = (asRecord(value.min_interval_seconds_by_provider) ?? {}) as Record<string, unknown>;
  const providerKeys = Object.keys(asRecord(initialConfig.providers) ?? {});

  return (
    <>
      <FormField
        label="Background interval"
        help="Seconds between automatic syncs across all providers. 0 disables background sync."
      >
        <NumberInput
          value={interval}
          min={0}
          step={5}
          suffix="s"
          onChange={(v) => onChange((cur) => ({ ...cur, background_interval_seconds: v ?? 0 }))}
        />
      </FormField>

      <NumberMapEditor
        label="Per-provider minimum interval"
        help="Floors that protect against rate limits. Seconds."
        value={map}
        suggestions={providerKeys}
        suffix="s"
        onChange={(next) => onChange((cur) => ({ ...cur, min_interval_seconds_by_provider: next }))}
      />

      <div className="rounded-2xl border border-warning/30 bg-warning-bg/40 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <Label>Maintenance</Label>
            <div className="mt-1 text-sm font-medium text-fg">Full sync</div>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-fg-muted">
              Resets the active provider&apos;s sync watermark and fetches everything it currently
              exposes again. Use this when cached items look incomplete or a prior filtered sync
              left the local cache in a bad state.
            </p>
          </div>
          <button
            type="button"
            onClick={onFullSync}
            disabled={fullSyncPending}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-warning/40 bg-warning-bg px-4 py-2 text-sm font-semibold text-warning-fg hover:bg-warning-bg/80 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw className={cn("h-4 w-4", fullSyncPending && "animate-spin")} />
            {fullSyncPending ? "Running full sync…" : "Run full sync"}
          </button>
        </div>
        {fullSyncError && <p className="mt-3 text-sm text-danger-fg">{fullSyncError}</p>}
      </div>
    </>
  );
}
