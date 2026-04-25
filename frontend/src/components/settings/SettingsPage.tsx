import { Braces, FormInput, RotateCcw, Save, Settings2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useManualSync, usePatchSettings, useSettings } from "~/api/hooks";
import { StatusPill } from "~/components/common/FormInputs";
import { Notice } from "~/components/common/Notice";
import { McpPage } from "~/components/mcp/McpPage";
import { cn } from "~/lib/cn";
import { outlineButtonClass, primaryButtonClass } from "~/lib/formClasses";
import { MODE_STORAGE_KEY, SECTIONS } from "./_constants";
import {
  asRecord,
  buildFormPatch,
  cloneSection,
  deepMerge,
  parseRawDraft,
  readPersistedMode,
} from "./_helpers";
import { ModeButton, PageState } from "./_shared";
import type { ConfigMap, Mode, SectionKey, SectionMeta } from "./_types";
import { FormPanel } from "./FormPanel";
import { PromptsPanel } from "./PromptsPanel";
import { RawEditor } from "./RawEditor";

export function SettingsPage() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const manualSync = useManualSync();

  const initialConfig = useMemo<ConfigMap>(
    () => asRecord(settings.data?.config) ?? {},
    [settings.data],
  );

  const [mode, setMode] = useState<Mode>(() => readPersistedMode());
  const [activeSection, setActiveSection] = useState<SectionKey>("llm");

  // Form state is keyed by section so we can build a minimal patch from only
  // touched sections. `undefined` means "user hasn't edited this section",
  // which keeps it out of the PATCH body.
  const [formDraft, setFormDraft] = useState<Partial<Record<SectionKey, ConfigMap>>>({});
  const [rawDraft, setRawDraft] = useState<string>("");
  const [rawSyncedFromConfigKey, setRawSyncedFromConfigKey] = useState<string>("");
  const [restartHints, setRestartHints] = useState<string[]>([]);
  const [savedFlash, setSavedFlash] = useState(false);

  const configKey = useMemo(() => JSON.stringify(initialConfig), [initialConfig]);
  useEffect(() => {
    setFormDraft({});
    if (rawSyncedFromConfigKey !== configKey) {
      setRawDraft(JSON.stringify(initialConfig, null, 2));
      setRawSyncedFromConfigKey(configKey);
    }
  }, [configKey, initialConfig, rawSyncedFromConfigKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage errors (private mode, etc.).
    }
  }, [mode]);

  const formPatch = useMemo(
    () => buildFormPatch(formDraft, initialConfig),
    [formDraft, initialConfig],
  );
  const rawParsed = useMemo(
    () => (mode === "raw" ? parseRawDraft(rawDraft) : { value: null, error: null }),
    [mode, rawDraft],
  );

  const dirty =
    mode === "form"
      ? Object.keys(formPatch).length > 0
      : rawDraft !== JSON.stringify(initialConfig, null, 2);

  const canSave =
    dirty &&
    !patch.isPending &&
    (mode === "form" ? Object.keys(formPatch).length > 0 : !rawParsed.error && !!rawParsed.value);

  useEffect(() => {
    if (!patch.isSuccess || dirty) return;
    setSavedFlash(true);
    const id = window.setTimeout(() => setSavedFlash(false), 2200);
    return () => window.clearTimeout(id);
  }, [patch.isSuccess, dirty]);

  useEffect(() => {
    if (patch.data?.requires_restart?.length) {
      setRestartHints(patch.data.requires_restart);
    }
  }, [patch.data]);
  useEffect(() => {
    if (dirty) setRestartHints([]);
  }, [dirty]);

  const updateSection = useCallback(
    (section: SectionKey, updater: (current: ConfigMap) => ConfigMap) => {
      setFormDraft((prev) => {
        const current = prev[section] ?? cloneSection(initialConfig[section]);
        const next = updater(current);
        return { ...prev, [section]: next };
      });
    },
    [initialConfig],
  );

  const resetSection = useCallback((section: SectionKey) => {
    setFormDraft((prev) => {
      if (!(section in prev)) return prev;
      const { [section]: _omit, ...rest } = prev;
      return rest;
    });
  }, []);

  const revertAll = useCallback(() => {
    patch.reset();
    setFormDraft({});
    setRawDraft(JSON.stringify(initialConfig, null, 2));
    setRestartHints([]);
  }, [initialConfig, patch]);

  const save = useCallback(() => {
    if (mode === "form") {
      if (Object.keys(formPatch).length === 0) return;
      patch.mutate({ patch: formPatch });
    } else {
      if (!rawParsed.value || rawParsed.error) return;
      patch.mutate({ patch: rawParsed.value });
    }
  }, [mode, formPatch, rawParsed.value, rawParsed.error, patch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        // The prompts and MCP panels own their own save shortcut.
        if (activeSection === "prompts" || activeSection === "mcp") return;
        event.preventDefault();
        if (canSave) save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSection, canSave, save]);

  const switchMode = useCallback(
    (next: Mode) => {
      if (next === mode) return;
      if (next === "raw") {
        const merged = deepMerge(initialConfig, formPatch);
        setRawDraft(JSON.stringify(merged, null, 2));
        setMode("raw");
        return;
      }
      if (rawParsed.error || !rawParsed.value) {
        return;
      }
      const next$: Partial<Record<SectionKey, ConfigMap>> = {};
      for (const meta of SECTIONS) {
        const incoming = asRecord(rawParsed.value[meta.key]);
        const base = asRecord(initialConfig[meta.key]) ?? {};
        if (!incoming) continue;
        if (JSON.stringify(incoming) !== JSON.stringify(base)) {
          next$[meta.key] = incoming;
        }
      }
      setFormDraft(next$);
      setMode("form");
    },
    [mode, initialConfig, formPatch, rawParsed.error, rawParsed.value],
  );

  if (settings.isPending && !settings.data) {
    return (
      <PageState
        title="Loading settings"
        description="Fetching the current masked config from the backend."
      />
    );
  }

  if (settings.error) {
    return (
      <PageState title="Settings unavailable" description={settings.error.message} tone="error" />
    );
  }

  const activeMeta: SectionMeta =
    SECTIONS.find((s) => s.key === activeSection) ?? (SECTIONS[0] as SectionMeta);
  const dirtySectionKeys = new Set(Object.keys(formPatch) as SectionKey[]);
  const restartHintSet = new Set(restartHints);
  const formCanSwitchToForm = mode === "raw" && !rawParsed.error && !!rawParsed.value;

  return (
    <div className="flex h-full min-h-0 bg-bg">
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-auto border-b border-border bg-surface/80 px-3 py-4 lg:border-b-0 lg:border-r">
          <div className="mb-4 flex items-center gap-2 px-2">
            <div className="rounded-xl bg-accent/10 p-2 text-accent">
              <Settings2 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-fg">Settings</h1>
              <p className="truncate text-[11px] text-fg-muted">
                Edit your <code>config.toml</code>
              </p>
            </div>
          </div>

          <nav className="flex flex-col gap-1">
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              const isActive = section.key === activeSection;
              const isDirty = dirtySectionKeys.has(section.key);
              const needsRestart = restartHintSet.has(section.key);
              return (
                <button
                  key={section.key}
                  type="button"
                  onClick={() => setActiveSection(section.key)}
                  className={cn(
                    "flex items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors",
                    isActive ? "bg-accent/10 text-accent" : "text-fg hover:bg-surface-alt",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate font-medium">{section.label}</span>
                  {isDirty && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-warning"
                      title="Unsaved changes"
                    />
                  )}
                  {!isDirty && needsRestart && (
                    <span
                      className="rounded-full bg-warning-bg px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-warning-fg"
                      title="Restart required after last save"
                    >
                      restart
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="mt-6 border-t border-border pt-4">
            <div className="px-2 text-[11px] font-medium uppercase tracking-[0.18em] text-fg-muted">
              Editor mode
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1 rounded-xl bg-surface-alt p-1">
              <ModeButton
                active={mode === "form"}
                onClick={() => switchMode("form")}
                disabled={
                  activeSection === "prompts" ||
                  activeSection === "mcp" ||
                  (mode === "raw" && !formCanSwitchToForm)
                }
                icon={FormInput}
                label="Form"
              />
              <ModeButton
                active={mode === "raw"}
                onClick={() => switchMode("raw")}
                disabled={activeSection === "prompts" || activeSection === "mcp"}
                icon={Braces}
                label="Raw JSON"
              />
            </div>
            {activeSection === "prompts" ? (
              <p className="mt-2 px-2 text-[11px] text-fg-muted">Prompts have their own editor.</p>
            ) : activeSection === "mcp" ? (
              <p className="mt-2 px-2 text-[11px] text-fg-muted">
                MCP servers have their own editor.
              </p>
            ) : mode === "raw" && rawParsed.error ? (
              <p className="mt-2 px-2 text-[11px] text-danger">
                Fix JSON to switch back to form mode.
              </p>
            ) : null}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col overflow-hidden">
          {activeSection === "prompts" ? (
            <PromptsPanel />
          ) : activeSection === "mcp" ? (
            <McpPage />
          ) : (
            <>
              <header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface/70 px-6 py-4 backdrop-blur">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold text-fg">
                      {mode === "form" ? activeMeta.label : "Raw JSON"}
                    </h2>
                    <StatusPill
                      tone={dirty ? "warn" : savedFlash ? "ok" : "muted"}
                      label={dirty ? "Unsaved changes" : savedFlash ? "Saved" : "Up to date"}
                    />
                    {mode === "raw" && (
                      <StatusPill
                        tone={rawParsed.error ? "error" : "muted"}
                        label={rawParsed.error ? "Invalid JSON" : "Valid JSON"}
                      />
                    )}
                  </div>
                  <p className="mt-1 max-w-3xl text-sm text-fg-muted">
                    {mode === "form"
                      ? activeMeta.description
                      : "Edit the masked config JSON directly. Saves go through the same deep-merge endpoint."}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={revertAll}
                    disabled={!dirty}
                    className={outlineButtonClass}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Revert
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={!canSave}
                    className={primaryButtonClass}
                  >
                    <Save className="h-4 w-4" />
                    {patch.isPending ? "Saving…" : "Save changes"}
                    <span className="ml-1 hidden font-mono text-[10px] opacity-70 sm:inline">
                      ⌘S
                    </span>
                  </button>
                </div>
              </header>

              <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
                <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
                  {patch.error && (
                    <Notice tone="error" title="Save failed">
                      {patch.error.message}
                    </Notice>
                  )}
                  {!dirty && restartHints.length > 0 && (
                    <Notice tone="warning" title="Restart required">
                      {`The next launch is needed for: ${restartHints.join(", ")}.`}
                    </Notice>
                  )}

                  {mode === "form" ? (
                    <FormPanel
                      section={activeMeta}
                      initialConfig={initialConfig}
                      draft={formDraft[activeMeta.key]}
                      isDirty={dirtySectionKeys.has(activeMeta.key)}
                      onChange={(updater) => updateSection(activeMeta.key, updater)}
                      onResetSection={() => resetSection(activeMeta.key)}
                      onFullSync={() => manualSync.mutate({ full: true })}
                      fullSyncPending={manualSync.isPending}
                      fullSyncError={manualSync.error?.message ?? null}
                    />
                  ) : (
                    <RawEditor value={rawDraft} onChange={setRawDraft} error={rawParsed.error} />
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
