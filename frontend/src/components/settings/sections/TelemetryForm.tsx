import { FormField } from "~/components/common/FormField";
import { Select } from "~/components/common/FormInputs";
import { Toggle } from "~/components/common/Toggle";

import { LOG_LEVELS } from "../_constants";
import { getBoolean, getString } from "../_helpers";
import type { ConfigMap } from "../_types";

export function TelemetryForm({
  value,
  onChange,
}: {
  value: ConfigMap;
  onChange: (updater: (current: ConfigMap) => ConfigMap) => void;
}) {
  const enabled = getBoolean(value, "enabled") ?? true;
  const level = getString(value, "level") ?? "DEBUG";
  return (
    <>
      <FormField label="Telemetry" help="Anonymous diagnostics for the local runtime.">
        <Toggle
          checked={enabled}
          onChange={(v) => onChange((cur) => ({ ...cur, enabled: v }))}
          label={enabled ? "Enabled" : "Disabled"}
        />
      </FormField>
      <FormField
        label="Log level"
        help="Stdlib logging level. DEBUG captures the most context; raise to reduce log volume."
      >
        <Select
          value={level}
          options={LOG_LEVELS.map((l) => ({ value: l, label: l }))}
          onChange={(v) => onChange((cur) => ({ ...cur, level: v }))}
        />
      </FormField>
    </>
  );
}
