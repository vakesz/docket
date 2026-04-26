/**
 * Telemetry + HTTP host settings step.
 *
 * Collapses `_step_telemetry` and `_step_http_surface` from the CLI wizard
 * onto one screen — both are short and the user usually leaves the defaults.
 * Bind/port write straight into config.toml's `[http]`; the bearer token is
 * regenerated server-side at /setup/complete time.
 */
import type { DTO } from "~/api/client";
import { HelpText, NumberInput, TextInput } from "~/components/common/FormInputs";
import { Label } from "~/components/common/Label";
import { primaryButtonClass, setupCardClass } from "~/lib/formClasses";
import type { SettingsDraft } from "./types";

const TELEMETRY_LEVELS: DTO["TelemetryLevel"][] = ["DEBUG", "INFO", "WARNING", "ERROR"];

interface Props {
  draft: SettingsDraft;
  setDraft: React.Dispatch<React.SetStateAction<SettingsDraft>>;
  onBack: () => void;
  onNext: () => void;
}

export function SettingsStep({ draft, setDraft, onBack, onNext }: Props) {
  return (
    <div className={setupCardClass}>
      <section className="flex flex-col gap-2">
        <Label>Telemetry</Label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={draft.telemetry_enabled}
            onChange={(e) => setDraft((d) => ({ ...d, telemetry_enabled: e.target.checked }))}
            className="accent-accent"
          />
          Keep local structured logs and the cost ledger.
        </label>
        <HelpText>
          Logs are written to your XDG cache dir as JSON, never shipped off-device. Toggle this
          later from the in-app settings page.
        </HelpText>
        {draft.telemetry_enabled && (
          <div className="flex flex-col gap-2">
            <Label>Log level</Label>
            <select
              value={draft.telemetry_level}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  telemetry_level: e.target.value as DTO["TelemetryLevel"],
                }))
              }
              className="w-fit rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
            >
              {TELEMETRY_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
            <HelpText>
              DEBUG keeps everything (recommended — worker tracebacks only land here). Raise to
              reduce log volume.
            </HelpText>
          </div>
        )}
      </section>

      <section className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label>HTTP bind</Label>
          <TextInput
            value={draft.http_bind}
            onChange={(v) => setDraft((d) => ({ ...d, http_bind: v }))}
            placeholder="0.0.0.0"
          />
          <HelpText>Use 127.0.0.1 to keep the API local-only.</HelpText>
        </div>
        <div className="flex flex-col gap-2">
          <Label>HTTP port</Label>
          <NumberInput
            value={draft.http_port}
            onChange={(v) => setDraft((d) => ({ ...d, http_port: v ?? 8765 }))}
            min={1}
            max={65535}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-3">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={draft.run_initial_sync}
            onChange={(e) => setDraft((d) => ({ ...d, run_initial_sync: e.target.checked }))}
            className="accent-accent"
          />
          Run an initial sync after writing config.
        </label>
        <HelpText>
          Pulls the active provider's items into the local SQLite cache. Skip this if your token
          isn't yet authorized — you can run <code>docket sync --full</code> later.
        </HelpText>
      </section>

      <div className="flex justify-between">
        <button type="button" onClick={onBack} className="text-xs text-fg-muted hover:text-fg">
          ← Back
        </button>
        <button type="button" onClick={onNext} className={primaryButtonClass}>
          Next
        </button>
      </div>
    </div>
  );
}
