import { asRecord, getString } from "./_helpers";
import type { ConfigMap, SectionMeta } from "./_types";
import { HttpForm } from "./sections/HttpForm";
import { LlmForm } from "./sections/LlmForm";
import { ProvidersForm } from "./sections/ProvidersForm";
import { StaleForm } from "./sections/StaleForm";
import { SyncForm } from "./sections/SyncForm";
import { TelemetryForm } from "./sections/TelemetryForm";
import { UiForm } from "./sections/UiForm";

export function FormPanel({
  section,
  initialConfig,
  draft,
  isDirty,
  onChange,
  onResetSection,
  onFullSync,
  fullSyncPending,
  fullSyncError,
}: {
  section: SectionMeta;
  initialConfig: ConfigMap;
  draft: ConfigMap | undefined;
  isDirty: boolean;
  onChange: (updater: (current: ConfigMap) => ConfigMap) => void;
  onResetSection: () => void;
  onFullSync: () => void;
  fullSyncPending: boolean;
  fullSyncError: string | null;
}) {
  const value = draft ?? asRecord(initialConfig[section.key]) ?? {};

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-fg">{section.label}</h3>
            {section.requiresRestart && (
              <span
                className="rounded-full bg-surface-alt px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted"
                title="Saving fields here typically requires a restart"
              >
                restart-sensitive
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-fg-muted">{section.description}</p>
        </div>
        {isDirty && (
          <button
            type="button"
            onClick={onResetSection}
            className="shrink-0 text-xs text-fg-muted hover:text-fg"
          >
            Reset section
          </button>
        )}
      </div>

      <div className="flex flex-col gap-5 border-t border-border pt-5">
        {section.key === "providers" && (
          <ProvidersForm initialConfig={initialConfig} value={value} onChange={onChange} />
        )}
        {section.key === "llm" && <LlmForm value={value} onChange={onChange} />}
        {section.key === "http" && (
          <HttpForm
            value={value}
            initialToken={getString(asRecord(initialConfig.http), "token")}
            onChange={onChange}
          />
        )}
        {section.key === "ui" && <UiForm value={value} onChange={onChange} />}
        {section.key === "telemetry" && <TelemetryForm value={value} onChange={onChange} />}
        {section.key === "sync" && (
          <SyncForm
            initialConfig={initialConfig}
            value={value}
            onChange={onChange}
            onFullSync={onFullSync}
            fullSyncPending={fullSyncPending}
            fullSyncError={fullSyncError}
          />
        )}
        {section.key === "stale" && (
          <StaleForm initialConfig={initialConfig} value={value} onChange={onChange} />
        )}
      </div>
    </div>
  );
}
