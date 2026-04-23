import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { createFileRoute } from "@tanstack/react-router";
import CodeMirror from "@uiw/react-codemirror";
import {
  Activity,
  Bot,
  Braces,
  CheckCircle2,
  CircleAlert,
  Clock,
  FileText,
  FormInput,
  Globe,
  Palette,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Server,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  useManualSync,
  usePatchSettings,
  usePrompt,
  usePrompts,
  usePutPrompt,
  useResetPrompt,
  useSettings,
} from "~/api/hooks";
import type { components } from "~/api/schema";
import { ThemePicker } from "~/components/shell/ThemePicker";
import { docketCodeMirrorTheme } from "~/lib/cmTheme";
import { cn } from "~/lib/cn";

type PromptSummary = components["schemas"]["PromptSummaryDTO"];

// ---------- Types -----------------------------------------------------------

type ConfigMap = Record<string, unknown>;

type Mode = "form" | "raw";

type SectionKey = "providers" | "llm" | "http" | "ui" | "telemetry" | "sync" | "stale" | "prompts";

type SectionMeta = {
  key: SectionKey;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  requiresRestart: boolean;
};

const SECTIONS: SectionMeta[] = [
  {
    key: "providers",
    label: "Providers",
    description: "Configured backends and the active provider used at startup.",
    icon: Server,
    requiresRestart: true,
  },
  {
    key: "llm",
    label: "LLM",
    description: "Chat model, endpoint, and assistant loop tuning.",
    icon: Bot,
    requiresRestart: true,
  },
  {
    key: "http",
    label: "HTTP",
    description: "Local API surface, bind address, and bearer token.",
    icon: Globe,
    requiresRestart: true,
  },
  {
    key: "ui",
    label: "Interface",
    description: "Theme, default item kind, and UI presentation.",
    icon: Palette,
    requiresRestart: false,
  },
  {
    key: "telemetry",
    label: "Telemetry",
    description: "Anonymous diagnostics and runtime instrumentation.",
    icon: Activity,
    requiresRestart: false,
  },
  {
    key: "sync",
    label: "Sync",
    description: "Background refresh cadence and per-provider floors.",
    icon: RefreshCw,
    requiresRestart: true,
  },
  {
    key: "stale",
    label: "Staleness",
    description: "How long cached items can sit before being marked stale.",
    icon: Clock,
    requiresRestart: false,
  },
  {
    key: "prompts",
    label: "Prompts",
    description: "Edit the markdown prompt templates the agent uses.",
    icon: Sparkles,
    requiresRestart: false,
  },
];

const ITEM_KINDS = ["epic", "feature", "story", "task", "bug"] as const;
// Mirrors Textual's built-in available_themes keys (+ the meta "system"
// sentinel the TUI treats as "follow OS"). Kept in sync with the TUI's
// theme_picker widget; the Select allows custom entries so a user can point
// at a theme registered by a future plugin.
const THEME_OPTIONS = [
  "system",
  "textual-dark",
  "textual-light",
  "textual-ansi",
  "nord",
  "gruvbox",
  "catppuccin-mocha",
  "catppuccin-latte",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "dracula",
  "tokyo-night",
  "monokai",
  "flexoki",
  "solarized-light",
  "solarized-dark",
  "rose-pine",
  "rose-pine-moon",
  "rose-pine-dawn",
  "atom-one-dark",
  "atom-one-light",
] as const;
const MODE_STORAGE_KEY = "docket.settings.mode";

// ---------- Route -----------------------------------------------------------

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
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

  // Raw mode keeps its own JSON string so the textarea is fully controlled
  // even when no edits exist yet.
  const [rawDraft, setRawDraft] = useState<string>("");
  const [rawSyncedFromConfigKey, setRawSyncedFromConfigKey] = useState<string>("");
  const [restartHints, setRestartHints] = useState<string[]>([]);
  const [savedFlash, setSavedFlash] = useState(false);

  // Reset drafts when the upstream config changes (initial load + after save).
  const configKey = useMemo(() => JSON.stringify(initialConfig), [initialConfig]);
  useEffect(() => {
    setFormDraft({});
    if (rawSyncedFromConfigKey !== configKey) {
      setRawDraft(JSON.stringify(initialConfig, null, 2));
      setRawSyncedFromConfigKey(configKey);
    }
  }, [configKey, initialConfig, rawSyncedFromConfigKey]);

  // Persist mode preference.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage errors (private mode, etc.).
    }
  }, [mode]);

  // Build the effective patch object the backend would receive.
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

  // Show the "Saved" toast briefly after a successful save.
  useEffect(() => {
    if (!patch.isSuccess || dirty) return;
    setSavedFlash(true);
    const id = window.setTimeout(() => setSavedFlash(false), 2200);
    return () => window.clearTimeout(id);
  }, [patch.isSuccess, dirty]);

  // Surface restart hints from the last save until the user edits again.
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

  // Ctrl/Cmd+S
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        // The prompts panel owns its own save shortcut.
        if (activeSection === "prompts") return;
        event.preventDefault();
        if (canSave) save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSection, canSave, save]);

  // Mode switch with carry-over.
  const switchMode = useCallback(
    (next: Mode) => {
      if (next === mode) return;
      if (next === "raw") {
        // Bring pending form edits into the raw view so users don't lose work.
        const merged = deepMerge(initialConfig, formPatch);
        setRawDraft(JSON.stringify(merged, null, 2));
        setMode("raw");
        return;
      }
      // raw -> form: only allow when JSON parses; otherwise refuse.
      if (rawParsed.error || !rawParsed.value) {
        return;
      }
      // Translate raw value into per-section drafts where it differs from
      // the initial config.
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
        {/* ---- Sidebar ---- */}
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
                disabled={activeSection === "prompts" || (mode === "raw" && !formCanSwitchToForm)}
                icon={FormInput}
                label="Form"
              />
              <ModeButton
                active={mode === "raw"}
                onClick={() => switchMode("raw")}
                disabled={activeSection === "prompts"}
                icon={Braces}
                label="Raw JSON"
              />
            </div>
            {activeSection === "prompts" ? (
              <p className="mt-2 px-2 text-[11px] text-fg-muted">Prompts have their own editor.</p>
            ) : mode === "raw" && rawParsed.error ? (
              <p className="mt-2 px-2 text-[11px] text-danger">
                Fix JSON to switch back to form mode.
              </p>
            ) : null}
          </div>
        </aside>

        {/* ---- Main panel ---- */}
        <section className="flex min-h-0 flex-col overflow-hidden">
          {activeSection === "prompts" ? (
            <PromptsPanel />
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
                    className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-bg disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Revert
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={!canSave}
                    className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
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

// ---------- Form panel: dispatch by section ---------------------------------

function FormPanel({
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

// ---------- Section forms --------------------------------------------------

function ProvidersForm({
  initialConfig,
  value,
  onChange,
}: {
  initialConfig: ConfigMap;
  value: ConfigMap;
  onChange: (updater: (current: ConfigMap) => ConfigMap) => void;
}) {
  // The `providers` section is read-only here. The active provider lives on
  // the top level config, so we surface it for editing through a separate
  // patch path: we route changes via a synthetic `_active` key resolved at
  // patch-build time.
  const providers = asRecord(value.providers ?? initialConfig.providers) ?? {};
  const providerKeys = Object.keys(providers);
  const draftActive = (value._active as string | undefined) ?? null;
  const initialActive = getString(initialConfig, "active_provider") ?? "";
  const active = draftActive ?? initialActive;

  return (
    <>
      <FormField
        label="Active provider"
        help="Which configured backend Docket opens with at startup."
      >
        {providerKeys.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-2 text-sm text-fg-muted">
            No providers configured. Use the setup wizard to add one.
          </p>
        ) : (
          <Select
            value={active}
            options={providerKeys.map((k) => ({ value: k, label: providerLabel(providers[k], k) }))}
            onChange={(v) => onChange((cur) => ({ ...cur, _active: v }))}
          />
        )}
      </FormField>

      <div className="flex flex-col gap-3">
        <Label>Configured providers</Label>
        <p className="text-xs text-fg-muted">
          Provider configuration lives in <code>config.toml</code>. To add a new provider or change
          credentials, use the setup wizard or the Raw JSON mode.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {providerKeys.length === 0 ? (
            <div className="text-sm text-fg-muted">None.</div>
          ) : (
            providerKeys.map((k) => {
              const entry = asRecord(providers[k]) ?? {};
              const type = getString(entry, "type") ?? "unknown";
              const display = getString(entry, "display_name") ?? k;
              const activeScope = getString(entry, "active_scope") ?? "default";
              const scopes = asRecord(entry.scopes);
              const scopeCount = scopes ? Object.keys(scopes).length : 0;
              const isActive = k === active;
              return (
                <div
                  key={k}
                  className={cn(
                    "rounded-xl border p-3 text-sm",
                    isActive ? "border-accent/50 bg-accent/5" : "border-border",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-fg">{display}</div>
                    {isActive && (
                      <span className="rounded-full bg-accent/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent">
                        active
                      </span>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-fg-muted">
                    {k} · {type}
                  </div>
                  <div className="mt-1 text-xs text-fg-muted">
                    {scopeCount} scope{scopeCount === 1 ? "" : "s"} · active “{activeScope}”
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

function LlmForm({
  value,
  onChange,
}: {
  value: ConfigMap;
  onChange: (updater: (current: ConfigMap) => ConfigMap) => void;
}) {
  const endpoint = getString(value, "endpoint") ?? "";
  const deployment = getString(value, "deployment") ?? "";
  const compaction = getNumberValue(value, "compaction_threshold_tokens");
  const watch = getNumberValue(value, "external_watch_interval_seconds");

  return (
    <>
      <FormField label="Endpoint" help="Azure OpenAI chat-completions URL (including api-version).">
        <TextInput
          type="url"
          value={endpoint}
          onChange={(v) => onChange((cur) => setOrUnset(cur, "endpoint", v))}
          placeholder="https://…cognitiveservices.azure.com/…/chat/completions?api-version=…"
        />
      </FormField>

      <FormField label="Deployment" help="Azure OpenAI deployment name.">
        <TextInput
          value={deployment}
          onChange={(v) => onChange((cur) => ({ ...cur, deployment: v }))}
          placeholder="gpt-5"
        />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Compaction threshold" help="Tokens before older messages get summarized.">
          <NumberInput
            value={compaction}
            min={0}
            step={1000}
            onChange={(v) => onChange((cur) => ({ ...cur, compaction_threshold_tokens: v ?? 0 }))}
          />
        </FormField>
        <FormField
          label="External watch interval"
          help="Seconds between external-change checks. 0 disables the watcher."
        >
          <NumberInput
            value={watch}
            min={0}
            step={1}
            onChange={(v) =>
              onChange((cur) => ({ ...cur, external_watch_interval_seconds: v ?? 0 }))
            }
            suffix="s"
          />
        </FormField>
      </div>
    </>
  );
}

function HttpForm({
  value,
  initialToken,
  onChange,
}: {
  value: ConfigMap;
  initialToken: string | null;
  onChange: (updater: (current: ConfigMap) => ConfigMap) => void;
}) {
  const enabled = getBoolean(value, "enabled") ?? false;
  const bind = getString(value, "bind") ?? "";
  const port = getNumberValue(value, "port");
  // Token: only present in `value` if user typed something. Show the current
  // masked value as placeholder.
  const tokenInDraft = "token" in value ? String(value.token ?? "") : "";

  return (
    <>
      <FormField label="HTTP API" help="Expose the local FastAPI surface.">
        <Toggle
          checked={enabled}
          onChange={(v) => onChange((cur) => ({ ...cur, enabled: v }))}
          label={enabled ? "Enabled" : "Disabled"}
        />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
        <FormField label="Bind address" help="Hostname or IP the server listens on.">
          <TextInput
            value={bind}
            onChange={(v) => onChange((cur) => ({ ...cur, bind: v }))}
            placeholder="127.0.0.1"
          />
        </FormField>
        <FormField label="Port">
          <NumberInput
            value={port}
            min={1}
            max={65535}
            step={1}
            onChange={(v) => onChange((cur) => ({ ...cur, port: v ?? 0 }))}
          />
        </FormField>
      </div>

      <FormField
        label="Bearer token"
        help="Leave empty to keep the current token. Type a new value to replace it."
      >
        <TextInput
          type="password"
          value={tokenInDraft}
          onChange={(v) => onChange((cur) => setOrUnset(cur, "token", v))}
          placeholder={initialToken ? initialToken : "(no token set)"}
        />
      </FormField>
    </>
  );
}

function UiForm({
  value,
  onChange,
}: {
  value: ConfigMap;
  onChange: (updater: (current: ConfigMap) => ConfigMap) => void;
}) {
  const theme = getString(value, "theme") ?? "";
  const defaultKind = getString(value, "default_new_item_kind") ?? "task";
  const showAcceptance = getBoolean(value, "show_acceptance_criteria") ?? true;
  const tagLimit = getNumberValue(value, "tag_filter_collapse_limit");

  return (
    <>
      <FormField
        label="Web theme"
        help="Color theme for this web UI. Stored in your browser; does not affect the TUI."
      >
        <ThemePicker />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Theme" help="TUI (terminal) theme. Saved to config.toml.">
          <Select
            value={theme}
            options={THEME_OPTIONS.map((t) => ({ value: t, label: t }))}
            onChange={(v) => onChange((cur) => ({ ...cur, theme: v }))}
            allowCustom
            placeholder="textual-dark"
          />
        </FormField>
        <FormField label="Default new item kind">
          <Select
            value={defaultKind}
            options={ITEM_KINDS.map((k) => ({ value: k, label: k }))}
            onChange={(v) => onChange((cur) => ({ ...cur, default_new_item_kind: v }))}
          />
        </FormField>
      </div>

      <FormField
        label="Show acceptance criteria"
        help="Reveal the acceptance criteria block in item detail views."
      >
        <Toggle
          checked={showAcceptance}
          onChange={(v) => onChange((cur) => ({ ...cur, show_acceptance_criteria: v }))}
          label={showAcceptance ? "Visible" : "Hidden"}
        />
      </FormField>

      <FormField
        label="Tag filter collapse limit"
        help="Number of tag chips shown before the “+N more” toggle. 0 disables collapsing."
      >
        <NumberInput
          value={tagLimit}
          min={0}
          max={100}
          step={1}
          onChange={(v) => onChange((cur) => ({ ...cur, tag_filter_collapse_limit: v ?? 0 }))}
        />
      </FormField>
    </>
  );
}

function TelemetryForm({
  value,
  onChange,
}: {
  value: ConfigMap;
  onChange: (updater: (current: ConfigMap) => ConfigMap) => void;
}) {
  const enabled = getBoolean(value, "enabled") ?? true;
  return (
    <FormField label="Telemetry" help="Anonymous diagnostics for the local runtime.">
      <Toggle
        checked={enabled}
        onChange={(v) => onChange((cur) => ({ ...cur, enabled: v }))}
        label={enabled ? "Enabled" : "Disabled"}
      />
    </FormField>
  );
}

function SyncForm({
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

function StaleForm({
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

// ---------- Raw editor ------------------------------------------------------

function RawEditor({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  error: string | null;
}) {
  const lineCount = value ? value.split("\n").length : 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-xs text-fg-muted">
          <span>{lineCount} lines</span>
          <span>{value.length.toLocaleString()} chars</span>
          <span className="ml-auto font-mono text-[11px] text-fg-faint">
            JSON view of masked config
          </span>
        </div>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className={cn(
            "min-h-[480px] w-full flex-1 resize-none bg-transparent px-4 py-4 font-mono text-[13px] leading-6 text-fg outline-none",
            "placeholder:text-fg-faint",
          )}
          style={{ tabSize: 2 }}
        />
      </div>
      {error && (
        <Notice tone="error" title="JSON parse error">
          {error}
        </Notice>
      )}
    </div>
  );
}

// ---------- Building blocks -------------------------------------------------

function ModeButton({
  active,
  onClick,
  disabled,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-surface text-fg shadow-sm"
          : "text-fg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-40",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function FormField({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      {children}
      {help && <HelpText>{help}</HelpText>}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-muted">
      {children}
    </span>
  );
}

function HelpText({ children }: { children: ReactNode }) {
  return <span className="text-xs leading-5 text-fg-muted">{children}</span>;
}

function TextInput({
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg transition-colors focus:border-accent focus:outline-none"
    />
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  suffix,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <div className="flex w-full items-stretch overflow-hidden rounded-xl border border-border bg-surface focus-within:border-accent">
      <input
        type="number"
        value={value === null ? "" : value}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange(null);
            return;
          }
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : null);
        }}
        min={min}
        max={max}
        step={step}
        className="w-full bg-transparent px-3 py-2 text-sm text-fg outline-none"
      />
      {suffix && (
        <span className="flex items-center border-l border-border bg-bg px-2 text-xs text-fg-muted">
          {suffix}
        </span>
      )}
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
  allowCustom,
  placeholder,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  allowCustom?: boolean;
  placeholder?: string;
}) {
  const knownValues = new Set(options.map((o) => o.value));
  const isCustom = allowCustom && value !== "" && !knownValues.has(value);
  const [customMode, setCustomMode] = useState(isCustom);

  if (allowCustom && customMode) {
    return (
      <div className="flex w-full gap-2">
        <TextInput value={value} onChange={onChange} placeholder={placeholder} />
        <button
          type="button"
          onClick={() => {
            setCustomMode(false);
            onChange(options[0]?.value ?? "");
          }}
          className="rounded-xl border border-border px-3 text-xs text-fg-muted hover:bg-surface-alt"
        >
          Preset
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-full gap-2">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
      >
        {value === "" && <option value="">{placeholder ?? "— choose —"}</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {allowCustom && (
        <button
          type="button"
          onClick={() => setCustomMode(true)}
          className="rounded-xl border border-border px-3 text-xs text-fg-muted hover:bg-surface-alt"
        >
          Custom
        </button>
      )}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="inline-flex w-fit items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg hover:bg-surface-alt"
    >
      <span
        className={cn(
          "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
          checked ? "bg-accent" : "bg-surface-alt",
        )}
      >
        <span
          className={cn(
            "inline-block h-4 w-4 transform rounded-full bg-surface shadow transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </span>
      {label && <span>{label}</span>}
    </button>
  );
}

function NumberMapEditor({
  label,
  help,
  value,
  suggestions,
  suffix,
  onChange,
}: {
  label: string;
  help?: string;
  value: Record<string, unknown>;
  suggestions: string[];
  suffix?: string;
  onChange: (next: Record<string, number>) => void;
}) {
  // Maintain order via the rows array; React state for stable inputs.
  const initialRows = useMemo(
    () =>
      Object.entries(value).map(([k, v]) => ({
        id: makeRowId(k),
        key: k,
        value: typeof v === "number" ? v : Number(v) || 0,
      })),
    [value],
  );
  const [rows, setRows] = useState(initialRows);
  const lastSerializedRef = useRef<string>(JSON.stringify(initialRows));

  // Sync from upstream when value prop identity changes (e.g. reset).
  useEffect(() => {
    const serialized = JSON.stringify(initialRows);
    if (serialized !== lastSerializedRef.current) {
      setRows(initialRows);
      lastSerializedRef.current = serialized;
    }
  }, [initialRows]);

  const commit = useCallback(
    (next: typeof rows) => {
      setRows(next);
      const out: Record<string, number> = {};
      for (const row of next) {
        const key = row.key.trim();
        if (!key) continue;
        out[key] = row.value;
      }
      lastSerializedRef.current = JSON.stringify(next);
      onChange(out);
    },
    [onChange],
  );

  const addRow = (key = "") => {
    commit([...rows, { id: makeRowId(key), key, value: 0 }]);
  };

  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      {help && <HelpText>{help}</HelpText>}

      <div className="flex flex-col gap-2">
        {rows.length === 0 && (
          <p className="rounded-xl border border-dashed border-border px-3 py-2 text-xs text-fg-muted">
            No overrides set.
          </p>
        )}
        {rows.map((row, idx) => (
          <div key={row.id} className="grid grid-cols-[1fr_140px_auto] items-stretch gap-2">
            <TextInput
              value={row.key}
              onChange={(v) => {
                const next = [...rows];
                next[idx] = { ...row, key: v };
                commit(next);
              }}
              placeholder="provider key"
            />
            <NumberInput
              value={row.value}
              min={0}
              step={1}
              suffix={suffix}
              onChange={(v) => {
                const next = [...rows];
                next[idx] = { ...row, value: v ?? 0 };
                commit(next);
              }}
            />
            <button
              type="button"
              onClick={() => commit(rows.filter((_, i) => i !== idx))}
              className="rounded-xl border border-border px-2 text-fg-muted hover:bg-bg hover:text-danger"
              title="Remove"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => addRow()}
          className="inline-flex items-center gap-1 rounded-xl border border-border px-3 py-1.5 text-xs text-fg-muted hover:bg-surface-alt"
        >
          <Plus className="h-3 w-3" />
          Add override
        </button>
        {suggestions
          .filter((k) => !rows.some((r) => r.key === k))
          .map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => addRow(k)}
              className="rounded-full bg-surface-alt px-2 py-1 font-mono text-[11px] text-fg-muted hover:bg-surface-alt"
            >
              + {k}
            </button>
          ))}
      </div>
    </div>
  );
}

function StatusPill({ tone, label }: { tone: "ok" | "warn" | "error" | "muted"; label: string }) {
  const cls =
    tone === "ok"
      ? "bg-success-bg text-success-fg"
      : tone === "warn"
        ? "bg-warning-bg text-warning-fg"
        : tone === "error"
          ? "bg-danger-bg text-danger-fg"
          : "bg-surface-alt text-fg-muted";
  return <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", cls)}>{label}</span>;
}

function Notice({
  title,
  children,
  tone,
}: {
  title: string;
  children: string;
  tone: "error" | "warning";
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border px-4 py-3 text-sm",
        tone === "error"
          ? "border-danger bg-danger-bg text-danger-fg"
          : "border-warning bg-warning-bg text-warning-fg",
      )}
    >
      <div className="flex items-start gap-3">
        {tone === "error" ? (
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        )}
        <div>
          <div className="font-semibold">{title}</div>
          <div className="mt-1 leading-6">{children}</div>
        </div>
      </div>
    </div>
  );
}

function PageState({
  title,
  description,
  tone = "neutral",
}: {
  title: string;
  description: string;
  tone?: "neutral" | "error";
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-2xl border border-border bg-surface p-6 text-center shadow-sm">
        <div
          className={cn(
            "mx-auto flex h-11 w-11 items-center justify-center rounded-2xl",
            tone === "error" ? "bg-danger-bg text-danger-fg" : "bg-surface-alt text-fg-muted",
          )}
        >
          {tone === "error" ? (
            <CircleAlert className="h-5 w-5" />
          ) : (
            <Settings2 className="h-5 w-5" />
          )}
        </div>
        <h1 className="mt-4 text-lg font-semibold text-fg">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-fg-muted">{description}</p>
      </div>
    </div>
  );
}

// ---------- Helpers ---------------------------------------------------------

function readPersistedMode(): Mode {
  if (typeof window === "undefined") return "form";
  try {
    const v = window.localStorage.getItem(MODE_STORAGE_KEY);
    return v === "raw" ? "raw" : "form";
  } catch {
    return "form";
  }
}

function asRecord(value: unknown): ConfigMap | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ConfigMap) : null;
}

function getString(record: ConfigMap | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getBoolean(record: ConfigMap | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function getNumberValue(record: ConfigMap | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cloneSection(value: unknown): ConfigMap {
  const rec = asRecord(value);
  return rec ? JSON.parse(JSON.stringify(rec)) : {};
}

function setOrUnset(map: ConfigMap, key: string, value: string): ConfigMap {
  if (value === "") {
    const { [key]: _omit, ...rest } = map;
    return rest;
  }
  return { ...map, [key]: value };
}

function providerLabel(entry: unknown, key: string): string {
  const rec = asRecord(entry);
  const display = rec ? getString(rec, "display_name") : null;
  const type = rec ? getString(rec, "type") : null;
  if (display && type) return `${display} (${type})`;
  if (display) return display;
  return key;
}

function makeRowId(seed: string): string {
  return `${seed}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseRawDraft(draft: string): { value: ConfigMap | null; error: string | null } {
  if (!draft.trim()) {
    return { value: null, error: "The config editor cannot be empty." };
  }
  try {
    const parsed = JSON.parse(draft) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      return { value: null, error: "The top-level config must stay a JSON object." };
    }
    return { value: record, error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Build a minimal patch object from per-section drafts. Only sections the
 * user actually touched (i.e. differ from the initial config, ignoring our
 * synthetic `_active` key) are included. The `providers._active` synthetic
 * key is hoisted to the top-level `active_provider` field.
 */
function buildFormPatch(
  drafts: Partial<Record<SectionKey, ConfigMap>>,
  initialConfig: ConfigMap,
): ConfigMap {
  const out: ConfigMap = {};

  for (const meta of SECTIONS) {
    const draft = drafts[meta.key];
    if (!draft) continue;

    if (meta.key === "providers") {
      // Hoist active provider selection.
      if ("_active" in draft) {
        const active = String(draft._active ?? "");
        if (active !== (getString(initialConfig, "active_provider") ?? "")) {
          out.active_provider = active;
        }
      }
      // We don't currently surface provider edits via the form, so skip the
      // providers block itself unless the raw representation actually changed
      // (defensive — currently unreachable).
      const baseProviders = asRecord(initialConfig.providers) ?? {};
      const draftProviders = asRecord(draft.providers);
      if (draftProviders && JSON.stringify(draftProviders) !== JSON.stringify(baseProviders)) {
        out.providers = draftProviders;
      }
      continue;
    }

    const base = asRecord(initialConfig[meta.key]) ?? {};
    if (JSON.stringify(draft) !== JSON.stringify(base)) {
      out[meta.key] = draft;
    }
  }

  return out;
}

function deepMerge(base: ConfigMap, patch: ConfigMap): ConfigMap {
  const out: ConfigMap = JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries(patch)) {
    const baseValue = out[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      baseValue &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue)
    ) {
      out[key] = deepMerge(baseValue as ConfigMap, value as ConfigMap);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------- Prompts panel ---------------------------------------------------

type PromptFilter = "all" | "customized" | "default";

const PROMPT_FILTERS: { value: PromptFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "customized", label: "Edited" },
  { value: "default", label: "Default" },
];

function PromptsPanel() {
  const prompts = usePrompts();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PromptFilter>("all");

  const list = prompts.data ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((p) => {
      if (filter === "customized" && !p.customized) return false;
      if (filter === "default" && p.customized) return false;
      if (!q) return true;
      return (
        p.label.toLowerCase().includes(q) ||
        p.key.toLowerCase().includes(q) ||
        p.filename.toLowerCase().includes(q)
      );
    });
  }, [list, query, filter]);

  // Keep selection valid as the list / filter change.
  useEffect(() => {
    if (!list.length) return;
    if (!selected || !list.some((p) => p.key === selected)) {
      setSelected(filtered[0]?.key ?? list[0]?.key);
    }
  }, [list, filtered, selected]);

  if (prompts.isPending && !prompts.data) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
        Loading prompts…
      </div>
    );
  }
  if (prompts.error) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Notice tone="error" title="Prompts unavailable">
          {prompts.error.message}
        </Notice>
      </div>
    );
  }
  if (list.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-fg-muted">
        No prompt templates registered.
      </div>
    );
  }

  const customizedCount = list.filter((p) => p.customized).length;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)]">
      {/* Prompt list */}
      <aside className="flex min-h-0 flex-col overflow-hidden border-b border-border bg-surface/60 md:border-b-0 md:border-r">
        <div className="px-3 pb-3 pt-4">
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-fg-muted">
              Templates
            </div>
            <span className="font-mono text-[10px] text-fg-faint">
              {list.length}
              {customizedCount > 0 ? ` · ${customizedCount} edited` : ""}
            </span>
          </div>
          <label className="relative block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search prompts…"
              className="w-full rounded-xl border border-border bg-surface py-1.5 pl-8 pr-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none-muted"
            />
          </label>
          <div className="mt-2 grid grid-cols-3 gap-1 rounded-xl bg-surface-alt p-1">
            {PROMPT_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={cn(
                  "rounded-lg px-2 py-1 text-xs font-medium transition-colors",
                  filter === f.value
                    ? "bg-surface text-fg shadow-sm-alt"
                    : "text-fg-muted hover:text-fg-faint",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <nav className="min-h-0 flex-1 overflow-auto px-2 pb-3">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-fg-muted">
              No prompts match this filter.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {filtered.map((p) => (
                <PromptListItem
                  key={p.key}
                  prompt={p}
                  active={selected === p.key}
                  onSelect={() => setSelected(p.key)}
                />
              ))}
            </ul>
          )}
        </nav>
      </aside>

      {/* Prompt editor */}
      {selected ? (
        <PromptEditor key={selected} promptKey={selected} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
          Select a prompt to start editing.
        </div>
      )}
    </div>
  );
}

function PromptListItem({
  prompt,
  active,
  onSelect,
}: {
  prompt: PromptSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "group flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left transition-colors",
          active ? "bg-accent/10 text-accent" : "text-fg hover:bg-surface-alt",
        )}
      >
        <FileText
          className={cn("mt-0.5 h-4 w-4 shrink-0", active ? "text-accent" : "text-fg-faint")}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{prompt.label}</span>
            {prompt.customized && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" title="Customized" />
            )}
          </div>
          <div
            className={cn(
              "truncate font-mono text-[10px]",
              active ? "text-accent/80" : "text-fg-muted",
            )}
          >
            {prompt.filename}
          </div>
        </div>
      </button>
    </li>
  );
}

function PromptEditor({ promptKey }: { promptKey: string }) {
  const prompt = usePrompt(promptKey);
  const put = usePutPrompt();
  const reset = useResetPrompt();
  const [draft, setDraft] = useState<string>("");
  const [savedFlash, setSavedFlash] = useState(false);

  // Refresh the draft when the upstream content changes (initial load + after
  // a save / reset round-trip).
  useEffect(() => {
    if (prompt.data) setDraft(prompt.data.content_md);
  }, [prompt.data]);

  const dirty = !!prompt.data && draft !== prompt.data.content_md;
  const canSave = dirty && !put.isPending;

  const save = useCallback(() => {
    if (!canSave) return;
    put.mutate({ key: promptKey, contentMd: draft });
  }, [canSave, draft, promptKey, put]);

  const revert = useCallback(() => {
    if (!prompt.data) return;
    setDraft(prompt.data.content_md);
    put.reset();
  }, [prompt.data, put]);

  const onReset = useCallback(() => {
    if (!prompt.data?.customized) return;
    const ok = window.confirm(
      `Reset “${prompt.data.label}” to the bundled default?\n\nYour edits to ${prompt.data.filename} will be discarded.`,
    );
    if (!ok) return;
    reset.mutate(promptKey);
  }, [prompt.data, promptKey, reset]);

  // Cmd/Ctrl+S inside the prompts editor saves the prompt, not the config.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (canSave) save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSave, save]);

  // Brief "Saved" flash after a successful save.
  useEffect(() => {
    if (!put.isSuccess || dirty) return;
    setSavedFlash(true);
    const id = window.setTimeout(() => setSavedFlash(false), 2200);
    return () => window.clearTimeout(id);
  }, [put.isSuccess, dirty]);

  if (prompt.isPending && !prompt.data) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
        Loading prompt…
      </div>
    );
  }
  if (prompt.error) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Notice tone="error" title="Failed to load prompt">
          {prompt.error.message}
        </Notice>
      </div>
    );
  }
  if (!prompt.data) return null;

  const { label, filename, content_md, customized } = prompt.data;
  const lineCount = draft ? draft.split("\n").length : 0;
  const charCount = draft.length;
  const baseLineCount = content_md.split("\n").length;
  const delta = lineCount - baseLineCount;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-start gap-3 border-b border-border bg-surface/70 px-6 py-4 backdrop-blur">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-fg">{label}</h2>
            <StatusPill
              tone={dirty ? "warn" : savedFlash ? "ok" : "muted"}
              label={dirty ? "Unsaved changes" : savedFlash ? "Saved" : "Up to date"}
            />
            {customized && !dirty && (
              <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
                Customized
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-fg-muted">
            <span className="truncate">{filename}</span>
            <span aria-hidden>·</span>
            <span>
              {lineCount} line{lineCount === 1 ? "" : "s"}
            </span>
            <span aria-hidden>·</span>
            <span>{charCount.toLocaleString()} chars</span>
            {dirty && delta !== 0 && (
              <>
                <span aria-hidden>·</span>
                <span className={delta > 0 ? "text-success-fg" : "text-danger-fg"}>
                  {delta > 0 ? `+${delta}` : delta} lines
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onReset}
            disabled={!customized || reset.isPending || dirty}
            title={
              dirty
                ? "Revert your unsaved changes first"
                : !customized
                  ? "This prompt is already the bundled default"
                  : "Restore the bundled default content"
            }
            className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-bg disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Sparkles className="h-4 w-4" />
            {reset.isPending ? "Resetting…" : "Reset to default"}
          </button>
          <button
            type="button"
            onClick={revert}
            disabled={!dirty}
            className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-bg disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className="h-4 w-4" />
            Revert
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {put.isPending ? "Saving…" : "Save changes"}
            <span className="ml-1 hidden font-mono text-[10px] opacity-70 sm:inline">⌘S</span>
          </button>
        </div>
      </header>

      {(put.error || reset.error) && (
        <div className="border-b border-border bg-bg/60 px-6 py-3">
          <Notice tone="error" title={put.error ? "Save failed" : "Reset failed"}>
            {(put.error ?? reset.error)?.message ?? "Unknown error"}
          </Notice>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden bg-bg">
        <CodeMirror
          value={draft}
          height="100%"
          theme="none"
          extensions={[markdown(), EditorView.lineWrapping, ...docketCodeMirrorTheme()]}
          onChange={setDraft}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
          }}
          className="h-full text-[13px]"
        />
      </div>
    </div>
  );
}
