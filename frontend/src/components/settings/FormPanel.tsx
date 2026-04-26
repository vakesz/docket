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
  onChange,
  onFullSync,
  fullSyncPending,
  fullSyncError,
}: {
  section: SectionMeta;
  initialConfig: ConfigMap;
  draft: ConfigMap | undefined;
  onChange: (updater: (current: ConfigMap) => ConfigMap) => void;
  onFullSync: () => void;
  fullSyncPending: boolean;
  fullSyncError: string | null;
}) {
  const value = draft ?? asRecord(initialConfig[section.key]) ?? {};

  return (
    <div className="flex flex-col gap-5 rounded-2xl border border-border bg-surface p-6 shadow-sm">
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
  );
}
