import { FormField } from "~/components/common/FormField";
import { NumberInput } from "~/components/common/FormInputs";

import { asRecord, getNumberValue } from "../_helpers";
import { NumberMapEditor } from "../_shared";
import type { ConfigMap } from "../_types";

export function StaleForm({
  initialConfig,
  value,
  onChange,
}: {
  initialConfig: ConfigMap;
  value: ConfigMap;
  onChange: (updater: (current: ConfigMap) => ConfigMap) => void;
}) {
  const days = getNumberValue(value, "threshold_days");
  const map = (asRecord(value.threshold_days_by_provider) ?? {}) as Record<string, unknown>;
  const providerKeys = Object.keys(asRecord(initialConfig.providers) ?? {});

  return (
    <>
      <FormField
        label="Default staleness threshold"
        help="Days a cached item can sit before the STALE marker appears."
      >
        <NumberInput
          value={days}
          min={0}
          step={1}
          suffix="d"
          onChange={(v) => onChange((cur) => ({ ...cur, threshold_days: v ?? 0 }))}
        />
      </FormField>

      <NumberMapEditor
        label="Per-provider override (days)"
        help="Per-provider thresholds win over the default."
        value={map}
        suggestions={providerKeys}
        suffix="d"
        onChange={(next) => onChange((cur) => ({ ...cur, threshold_days_by_provider: next }))}
      />
    </>
  );
}
