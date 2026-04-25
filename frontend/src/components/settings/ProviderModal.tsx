import { Plus, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { DTO } from "~/api/client";
import {
  useAddProvider,
  useSettingsProviderTypes,
  useTestSettingsProvider,
  useUpdateProvider,
} from "~/api/hooks";
import { Select, TextInput } from "~/components/common/FormInputs";
import { Modal } from "~/components/common/Modal";
import { Notice } from "~/components/common/Notice";
import { Toggle } from "~/components/common/Toggle";
import { primaryButtonClass } from "~/lib/formClasses";
import { readOnlyFieldClass } from "./_constants";
import { asRecord, getString } from "./_helpers";
import { FormField } from "./_shared";

type ProviderTypeDTO = DTO["SetupProviderTypeDTO"];
type ProviderFieldDTO = DTO["SetupProviderFieldDTO"];

type ProviderModalProps =
  | {
      mode: "add";
      existingKeys: string[];
      existingKey?: undefined;
      existingEntry?: undefined;
      onClose: () => void;
      onSaved: (key: string) => void;
    }
  | {
      mode: "edit";
      existingKeys: string[];
      existingKey: string;
      existingEntry: Record<string, unknown>;
      onClose: () => void;
      onSaved: (key: string) => void;
    };

export function ProviderModal(props: ProviderModalProps) {
  const { mode, existingKeys, onClose, onSaved } = props;
  const isEdit = mode === "edit";
  const types = useSettingsProviderTypes();
  const testMutation = useTestSettingsProvider();
  const addMutation = useAddProvider();
  const updateMutation = useUpdateProvider();

  const existingType = isEdit ? (getString(props.existingEntry, "type") ?? "") : "";
  const existingConfig = isEdit ? (asRecord(props.existingEntry.config) ?? {}) : {};
  const existingDisplay = isEdit ? (getString(props.existingEntry, "display_name") ?? "") : "";

  const [selectedType, setSelectedType] = useState<string>(existingType);
  const [key, setKey] = useState<string>(isEdit ? props.existingKey : "");
  const [displayName, setDisplayName] = useState<string>(existingDisplay);
  const [makeActive, setMakeActive] = useState(false);
  // Per-type field values so switching the dropdown doesn't wipe what the user
  // already typed for another type. Only the slot for `selectedType` is sent.
  const [fieldValuesByType, setFieldValuesByType] = useState<
    Record<string, Record<string, string>>
  >(() => {
    if (!isEdit) return {};
    const seeded: Record<string, string> = {};
    for (const [k, v] of Object.entries(existingConfig)) {
      seeded[k] = v == null ? "" : String(v);
    }
    return { [existingType]: seeded };
  });
  const [testResult, setTestResult] = useState<DTO["SetupTestResultDTO"] | null>(null);

  const spec = useMemo<ProviderTypeDTO | null>(
    () => types.data?.find((t) => t.id === selectedType) ?? null,
    [types.data, selectedType],
  );

  const fieldValues = fieldValuesByType[selectedType] ?? {};

  useEffect(() => {
    if (isEdit) return;
    if (!selectedType && types.data && types.data.length > 0) {
      setSelectedType(types.data[0]?.id ?? "");
    }
  }, [types.data, selectedType, isEdit]);

  useEffect(() => {
    if (isEdit) return;
    if (!selectedType) return;
    if (existingKeys.includes(key)) return;
    if (!existingKeys.includes(selectedType)) {
      setKey((prev) => prev || selectedType);
      return;
    }
    let i = 2;
    while (existingKeys.includes(`${selectedType}-${i}`)) i += 1;
    setKey((prev) => prev || `${selectedType}-${i}`);
  }, [selectedType, existingKeys, key, isEdit]);

  const onField = (k: string, v: string) => {
    setFieldValuesByType((prev) => ({
      ...prev,
      [selectedType]: { ...(prev[selectedType] ?? {}), [k]: v },
    }));
    setTestResult(null);
  };

  const missingRequired = useMemo(() => {
    if (!spec) return true;
    return (spec.fields ?? []).some((f) => f.required && !(fieldValues[f.key] ?? "").trim());
  }, [spec, fieldValues]);

  const keyInvalid = !isEdit && (!key.trim() || existingKeys.includes(key));

  const runTest = () => {
    if (!spec || missingRequired) return;
    setTestResult(null);
    testMutation.mutate(
      { type: spec.id, config: fieldValues },
      { onSuccess: (r) => setTestResult(r) },
    );
  };

  const submitMutation = isEdit ? updateMutation : addMutation;

  const runSubmit = () => {
    if (!spec || missingRequired) return;
    if (isEdit) {
      updateMutation.mutate(
        {
          key: props.existingKey,
          body: {
            display_name: displayName.trim() || props.existingKey,
            config: fieldValues,
          },
        },
        { onSuccess: () => onSaved(props.existingKey) },
      );
      return;
    }
    if (keyInvalid) return;
    addMutation.mutate(
      {
        key: key.trim(),
        type: spec.id,
        display_name: displayName.trim() || key.trim(),
        config: fieldValues,
        scope: {},
        make_active: makeActive,
      },
      { onSuccess: () => onSaved(key.trim()) },
    );
  };

  const title = isEdit ? "Edit provider" : "Add provider";
  const subtitle = isEdit
    ? "Rotate credentials or tweak config for this backend. Key and type are fixed — remove and re-add to change them."
    : "Register a new backend at runtime. A server restart is required before it becomes fully wired in the agent loop.";
  const submitLabel = isEdit
    ? updateMutation.isPending
      ? "Saving…"
      : "Save changes"
    : addMutation.isPending
      ? "Adding…"
      : "Add provider";

  return (
    <Modal onClose={onClose} className="max-h-[85vh] max-w-3xl">
      <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div>
          <h3 className="text-base font-semibold text-fg">{title}</h3>
          <p className="mt-0.5 text-xs text-fg-muted">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl border border-border px-2 py-1 text-xs text-fg-muted hover:bg-surface-alt"
        >
          Close
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-auto px-6 py-5">
        {types.isPending ? (
          <p className="text-sm text-fg-muted">Loading provider types…</p>
        ) : types.error ? (
          <Notice tone="error" title="Failed to load provider types">
            {(types.error as Error).message}
          </Notice>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Provider type">
                {isEdit ? (
                  <div className={readOnlyFieldClass}>{existingType || "unknown"}</div>
                ) : (
                  <Select
                    value={selectedType}
                    options={(types.data ?? []).map((t) => ({
                      value: t.id,
                      label: `${t.display} (${t.id})`,
                    }))}
                    onChange={setSelectedType}
                  />
                )}
              </FormField>
              <FormField
                label="Config key"
                help={
                  isEdit
                    ? "Immutable once created. Remove and re-add to change."
                    : "Short id used internally (e.g. in tool names, tickets). Must be unique."
                }
              >
                {isEdit ? (
                  <div className={readOnlyFieldClass}>{key}</div>
                ) : (
                  <TextInput value={key} onChange={setKey} placeholder="github-work" />
                )}
              </FormField>
            </div>

            <FormField label="Display name" help="Shown in the UI.">
              <TextInput
                value={displayName}
                onChange={setDisplayName}
                placeholder={isEdit ? props.existingKey : key}
              />
            </FormField>

            {!isEdit && keyInvalid && key.trim() && (
              <p className="text-xs text-danger">
                Provider '{key}' already exists. Pick a different key.
              </p>
            )}

            {spec?.requires_cli && spec.requires_cli.length > 0 && (
              <Notice tone="warning" title="CLI auth required">
                {`This provider uses the \`${spec.requires_cli.join(", ")}\` CLI(s). Make sure you're signed in on the server host before ${isEdit ? "saving" : "adding"}.`}
              </Notice>
            )}

            {(spec?.fields ?? []).length > 0 && (
              <div className="grid gap-4 sm:grid-cols-2">
                {(spec?.fields ?? []).map((f) => (
                  <ProviderFieldInput
                    key={f.key}
                    field={f}
                    value={fieldValues[f.key] ?? ""}
                    onChange={(v) => onField(f.key, v)}
                  />
                ))}
              </div>
            )}

            {!isEdit && (
              <FormField label="Make active">
                <Toggle
                  checked={makeActive}
                  onChange={setMakeActive}
                  label={makeActive ? "Will become active" : "Keep current active provider"}
                />
              </FormField>
            )}

            {testResult && (
              <Notice
                tone={testResult.ok ? "ok" : "error"}
                title={testResult.ok ? "Provider reachable" : "Provider test failed"}
              >
                {testResult.ok
                  ? isEdit
                    ? "Connection test passed. You can save now."
                    : "Connection test passed. You can add the provider now."
                  : (testResult.error ?? "Unknown error")}
              </Notice>
            )}
            {submitMutation.error && (
              <Notice tone="error" title={isEdit ? "Save failed" : "Add failed"}>
                {(submitMutation.error as Error).message}
              </Notice>
            )}
          </>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
        <button
          type="button"
          onClick={runTest}
          disabled={!spec || missingRequired || testMutation.isPending}
          className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-40"
        >
          {testMutation.isPending ? "Testing…" : "Test connection"}
        </button>
        <button
          type="button"
          onClick={runSubmit}
          disabled={
            !spec ||
            keyInvalid ||
            missingRequired ||
            submitMutation.isPending ||
            (!!testResult && !testResult.ok)
          }
          className={primaryButtonClass}
        >
          {isEdit ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {submitLabel}
        </button>
      </div>
    </Modal>
  );
}

function ProviderFieldInput({
  field,
  value,
  onChange,
}: {
  field: ProviderFieldDTO;
  value: string;
  onChange: (v: string) => void;
}) {
  const inputType = field.kind === "secret" ? "password" : field.kind === "url" ? "url" : "text";
  return (
    <FormField
      label={field.label + (field.required ? "" : " (optional)")}
      help={field.help || undefined}
    >
      <TextInput
        type={inputType}
        value={value}
        onChange={onChange}
        placeholder={field.placeholder || undefined}
      />
    </FormField>
  );
}
