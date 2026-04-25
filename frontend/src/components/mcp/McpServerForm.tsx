import { CheckCircle2, CircleAlert, FlaskConical, Plus, Save, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { DTO } from "~/api/client";
import {
  useCreateMcpServer,
  useDeleteMcpServer,
  useTestMcpServer,
  useTestMcpServerDraft,
  useUpdateMcpServer,
} from "~/api/hooks";
import { Notice } from "~/components/common/Notice";
import { cn } from "~/lib/cn";

// Server names act as dict keys in `config.toml` under `[projects.<id>.mcp.<name>]`;
// the backend also enforces the same shape (`tui_parity.validate_mcp_server_name`).
// We validate client-side too so users get feedback before a roundtrip.
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface McpServerDraft {
  name: string;
  command: string;
  args: string; // whitespace-separated; split on submit
  env: { key: string; value: string }[];
  transport: string;
  enabled: boolean;
  startup_timeout_seconds: number;
}

export function blankDraft(): McpServerDraft {
  return {
    name: "",
    command: "",
    args: "",
    env: [],
    transport: "stdio",
    enabled: true,
    startup_timeout_seconds: 10,
  };
}

export function draftFromServer(server: DTO["MCPServerDTO"]): McpServerDraft {
  return {
    name: server.name,
    command: server.command ?? "",
    args: (server.args ?? []).join(" "),
    env: Object.entries(server.env ?? {}).map(([key, value]) => ({ key, value })),
    transport: server.transport ?? "stdio",
    enabled: server.enabled ?? true,
    startup_timeout_seconds: server.startup_timeout_seconds ?? 10,
  };
}

/** Split args on any whitespace, dropping empty tokens. We intentionally do
 * not support shell-quoting — the TUI and CLI are the same way. If you need
 * a literal space in an argument, use the env map or wrap the value in
 * `sh -c`. */
function parseArgs(raw: string): string[] {
  return raw.split(/\s+/u).filter((p) => p.length > 0);
}

function serializeDraft(
  draft: McpServerDraft,
): Omit<DTO["MCPServerCreateRequest"], "name"> & { name?: string } {
  const env: Record<string, string> = {};
  for (const { key, value } of draft.env) {
    const k = key.trim();
    if (!k) continue;
    env[k] = value;
  }
  return {
    name: draft.name.trim(),
    command: draft.command.trim(),
    args: parseArgs(draft.args),
    env,
    transport: draft.transport || "stdio",
    enabled: draft.enabled,
    startup_timeout_seconds: draft.startup_timeout_seconds,
  };
}

export function McpServerForm({
  projectId,
  draft: initialDraft,
  mode,
  readOnly,
  onCreated,
  onDeleted,
}: {
  projectId: string;
  draft: McpServerDraft;
  mode: "create" | "edit";
  readOnly: boolean;
  onCreated?: (name: string) => void;
  onDeleted?: () => void;
}) {
  const create = useCreateMcpServer(projectId);
  const update = useUpdateMcpServer(projectId);
  const del = useDeleteMcpServer(projectId);
  const testSaved = useTestMcpServer(projectId);
  const testDraft = useTestMcpServerDraft(projectId);

  const [draft, setDraft] = useState<McpServerDraft>(initialDraft);
  const [testResult, setTestResult] = useState<DTO["MCPServerTestResultDTO"] | null>(null);

  const baseDraftKey = useMemo(() => JSON.stringify(initialDraft), [initialDraft]);
  // Reset the form when the caller swaps to a different entry (or mode).
  // biome-ignore lint/correctness/useExhaustiveDependencies: swapping driven by baseDraftKey change, not live mutations.
  useEffect(() => {
    setDraft(initialDraft);
    setTestResult(null);
    create.reset();
    update.reset();
    del.reset();
    testSaved.reset();
    testDraft.reset();
  }, [baseDraftKey]);

  const nameError = useMemo(() => {
    if (mode !== "create") return null;
    const trimmed = draft.name.trim();
    if (!trimmed) return "Name is required.";
    if (!NAME_PATTERN.test(trimmed)) {
      return "Name must start with a letter/digit and contain only letters, digits, _ or - (max 64 chars).";
    }
    return null;
  }, [draft.name, mode]);

  const commandError = draft.command.trim().length === 0 ? "Command is required." : null;
  const timeoutError =
    !Number.isFinite(draft.startup_timeout_seconds) || draft.startup_timeout_seconds <= 0
      ? "Startup timeout must be greater than 0."
      : null;

  const formError = nameError || commandError || timeoutError;

  const dirty = useMemo(() => JSON.stringify(draft) !== baseDraftKey, [draft, baseDraftKey]);

  const save = useCallback(async () => {
    if (readOnly || formError) return;
    const payload = serializeDraft(draft);
    if (mode === "create") {
      const body: DTO["MCPServerCreateRequest"] = {
        name: payload.name ?? "",
        command: payload.command ?? "",
        args: payload.args,
        env: payload.env,
        transport: payload.transport ?? "stdio",
        enabled: payload.enabled ?? true,
        startup_timeout_seconds: payload.startup_timeout_seconds ?? 10,
      };
      const created = await create.mutateAsync(body);
      onCreated?.(created.name);
    } else {
      // PATCH body — we send everything that could have changed. The backend
      // treats omitted keys as "leave alone" and explicit empty containers as
      // "clear" (per MCPServerUpdateRequest docs).
      const body: DTO["MCPServerUpdateRequest"] = {
        command: payload.command ?? "",
        args: payload.args,
        env: payload.env,
        transport: payload.transport ?? "stdio",
        enabled: payload.enabled ?? true,
        startup_timeout_seconds: payload.startup_timeout_seconds ?? 10,
      };
      await update.mutateAsync({ name: initialDraft.name, body });
    }
  }, [create, draft, formError, initialDraft.name, mode, onCreated, readOnly, update]);

  const onDelete = useCallback(async () => {
    if (readOnly || mode !== "edit") return;
    const ok = window.confirm(
      `Delete MCP server “${initialDraft.name}”?\n\nThis removes it from config.toml. You can recreate it later.`,
    );
    if (!ok) return;
    await del.mutateAsync(initialDraft.name);
    onDeleted?.();
  }, [del, initialDraft.name, mode, onDeleted, readOnly]);

  const onTest = useCallback(async () => {
    if (readOnly || commandError) return;
    setTestResult(null);
    const payload = serializeDraft(draft);
    if (mode === "edit" && !dirty) {
      // Server is saved AND untouched — hit the saved test path so the runtime
      // fleet's live client config (if any) is exercised rather than a fresh
      // subprocess created just for the test.
      const result = await testSaved.mutateAsync(initialDraft.name);
      setTestResult(result);
      return;
    }
    const body: DTO["MCPServerTestRequest"] = {
      name: payload.name || initialDraft.name || "draft",
      command: payload.command ?? "",
      args: payload.args,
      env: payload.env,
      transport: payload.transport ?? "stdio",
      enabled: payload.enabled ?? true,
      startup_timeout_seconds: payload.startup_timeout_seconds ?? 10,
    };
    const result = await testDraft.mutateAsync(body);
    setTestResult(result);
  }, [commandError, dirty, draft, initialDraft.name, mode, readOnly, testDraft, testSaved]);

  const saving = create.isPending || update.isPending;
  const testing = testSaved.isPending || testDraft.isPending;
  const deleting = del.isPending;
  const saveError = create.error ?? update.error;
  const deleteError = del.error;
  const testError = testSaved.error ?? testDraft.error;

  // Ctrl/Cmd + S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!readOnly && !formError && !saving && (dirty || mode === "create")) {
          void save();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, formError, mode, readOnly, save, saving]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-start gap-3 border-b border-border bg-surface/70 px-6 py-4 backdrop-blur">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-fg">
              {mode === "create" ? "New MCP server" : initialDraft.name}
            </h2>
            <StatusPill
              tone={mode === "create" ? "muted" : dirty ? "warn" : "ok"}
              label={mode === "create" ? "Unsaved draft" : dirty ? "Unsaved changes" : "Up to date"}
            />
            {!draft.enabled && (
              <span className="rounded-full bg-surface-alt px-2.5 py-1 text-xs font-medium text-fg-muted">
                Disabled
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-fg-muted">
            {mode === "create"
              ? "Stdio MCP subprocess that exposes tools to the agent. Names are immutable once saved."
              : "Edit the server config. Changes restart the live subprocess on save."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void onTest()}
            disabled={readOnly || testing || Boolean(commandError)}
            className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-bg disabled:cursor-not-allowed disabled:opacity-40"
            title="Spawn the subprocess, run the MCP handshake, and list its tools"
          >
            <FlaskConical className="h-4 w-4" />
            {testing ? "Testing…" : "Test"}
          </button>
          {mode === "edit" && (
            <button
              type="button"
              onClick={() => void onDelete()}
              disabled={readOnly || deleting}
              className="inline-flex items-center gap-2 rounded-xl border border-danger/40 bg-danger-bg/40 px-3 py-2 text-sm font-medium text-danger-fg hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 className="h-4 w-4" />
              {deleting ? "Deleting…" : "Delete"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={readOnly || saving || Boolean(formError) || (mode === "edit" && !dirty)}
            className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? "Saving…" : mode === "create" ? "Create" : "Save changes"}
            <span className="ml-1 hidden font-mono text-[10px] opacity-70 sm:inline">⌘S</span>
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {readOnly && (
            <Notice tone="warning" title="Read-only mode">
              Saves, deletes, and tests are disabled.
            </Notice>
          )}
          {saveError && (
            <Notice tone="error" title="Save failed">
              {saveError.message}
            </Notice>
          )}
          {deleteError && (
            <Notice tone="error" title="Delete failed">
              {deleteError.message}
            </Notice>
          )}
          {testError && (
            <Notice tone="error" title="Test failed">
              {testError.message}
            </Notice>
          )}
          {testResult && <TestResultCard result={testResult} />}

          <section className="flex flex-col gap-5 rounded-2xl border border-border bg-surface p-6 shadow-sm">
            <FormField label="Name" help="Letters, digits, underscore and hyphen. Immutable.">
              <TextInput
                value={draft.name}
                onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
                placeholder="github"
                disabled={mode === "edit"}
              />
              {nameError && <FieldError>{nameError}</FieldError>}
            </FormField>

            <FormField
              label="Command"
              help="Executable that speaks MCP over stdio. Must be on PATH or absolute."
            >
              <TextInput
                value={draft.command}
                onChange={(v) => setDraft((d) => ({ ...d, command: v }))}
                placeholder="npx"
              />
              {commandError && <FieldError>{commandError}</FieldError>}
            </FormField>

            <FormField label="Arguments" help="Whitespace-separated. No shell quoting.">
              <TextInput
                value={draft.args}
                onChange={(v) => setDraft((d) => ({ ...d, args: v }))}
                placeholder="-y @modelcontextprotocol/server-github"
              />
            </FormField>

            <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
              <FormField label="Transport" help="Only stdio is supported today.">
                <Select
                  value={draft.transport}
                  options={[{ value: "stdio", label: "stdio" }]}
                  onChange={(v) => setDraft((d) => ({ ...d, transport: v }))}
                />
              </FormField>
              <FormField label="Startup timeout" help="Seconds for handshake + tools/list.">
                <NumberInput
                  value={draft.startup_timeout_seconds}
                  min={1}
                  step={1}
                  suffix="s"
                  onChange={(v) => setDraft((d) => ({ ...d, startup_timeout_seconds: v ?? 10 }))}
                />
                {timeoutError && <FieldError>{timeoutError}</FieldError>}
              </FormField>
            </div>

            <FormField label="Enabled" help="Disabled servers are skipped at bind time.">
              <Toggle
                checked={draft.enabled}
                onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
                label={draft.enabled ? "Enabled" : "Disabled"}
              />
            </FormField>

            <FormField
              label="Environment"
              help="Key/value pairs forwarded to the subprocess. Use for secrets like API tokens."
            >
              <EnvEditor
                value={draft.env}
                onChange={(next) => setDraft((d) => ({ ...d, env: next }))}
              />
            </FormField>
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------- Sub-components ---------------------------------------------------

function TestResultCard({ result }: { result: DTO["MCPServerTestResultDTO"] }) {
  const ok = result.ok;
  const tools = result.tool_details ?? [];
  const rawTools = result.tools ?? [];
  return (
    <div
      className={cn(
        "rounded-2xl border p-4",
        ok ? "border-success bg-success-bg/50" : "border-danger bg-danger-bg/50",
      )}
    >
      <div className="flex items-start gap-3">
        {ok ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success-fg" />
        ) : (
          <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-danger-fg" />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {ok
              ? `Connected — ${tools.length || rawTools.length} tool${
                  (tools.length || rawTools.length) === 1 ? "" : "s"
                }`
              : "Connection failed"}
          </div>
          {!ok && result.error && (
            <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-bg/60 p-2 font-mono text-xs text-danger-fg">
              {result.error}
            </pre>
          )}
          {ok && tools.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2">
              {tools.map((t) => (
                <li
                  key={t.id}
                  className="rounded-xl border border-border/60 bg-surface/70 p-3 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <Wrench className="h-3.5 w-3.5 text-fg-muted" />
                    <span className="font-mono text-xs text-fg">{t.name}</span>
                  </div>
                  {t.description && <p className="mt-1 text-xs text-fg-muted">{t.description}</p>}
                </li>
              ))}
            </ul>
          )}
          {ok && tools.length === 0 && rawTools.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1">
              {rawTools.map((name) => (
                <li key={name} className="font-mono text-xs text-fg-muted">
                  {name}
                </li>
              ))}
            </ul>
          )}
          {ok && tools.length === 0 && rawTools.length === 0 && (
            <p className="mt-1 text-xs text-fg-muted">
              The server responded but advertised no tools.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function EnvEditor({
  value,
  onChange,
}: {
  value: { key: string; value: string }[];
  onChange: (next: { key: string; value: string }[]) => void;
}) {
  const updateRow = (idx: number, patch: Partial<{ key: string; value: string }>) => {
    const next = value.map((row, i) => (i === idx ? { ...row, ...patch } : row));
    onChange(next);
  };
  const removeRow = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };
  const addRow = () => {
    onChange([...value, { key: "", value: "" }]);
  };

  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 && (
        <p className="rounded-xl border border-dashed border-border px-3 py-2 text-xs text-fg-muted">
          No env vars set.
        </p>
      )}
      {value.map((row, idx) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: env rows are ordered and the index is a stable identity while the row is mounted; swapping to random ids would force remount on every keystroke.
          key={idx}
          className="grid grid-cols-[1fr_1.5fr_auto] items-stretch gap-2"
        >
          <TextInput
            value={row.key}
            onChange={(v) => updateRow(idx, { key: v })}
            placeholder="GITHUB_PERSONAL_ACCESS_TOKEN"
          />
          <TextInput
            value={row.value}
            onChange={(v) => updateRow(idx, { value: v })}
            placeholder="ghp_…"
            type="password"
          />
          <button
            type="button"
            onClick={() => removeRow(idx)}
            className="rounded-xl border border-border px-2 text-fg-muted hover:bg-bg hover:text-danger"
            title="Remove"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="inline-flex w-fit items-center gap-1 rounded-xl border border-border px-3 py-1.5 text-xs text-fg-muted hover:bg-surface-alt"
      >
        <Plus className="h-3 w-3" />
        Add env var
      </button>
    </div>
  );
}

// ---------- Primitives (kept local to this module) -------------------------

function FormField({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-muted">
        {label}
      </span>
      {children}
      {help && <span className="text-xs leading-5 text-fg-muted">{help}</span>}
    </div>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-danger-fg">{children}</span>;
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={cn(
        "w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg transition-colors focus:border-accent focus:outline-none",
        disabled && "cursor-not-allowed opacity-60",
      )}
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
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
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
      <span>{label}</span>
    </button>
  );
}

function StatusPill({ tone, label }: { tone: "ok" | "warn" | "muted"; label: string }) {
  const cls =
    tone === "ok"
      ? "bg-success-bg text-success-fg"
      : tone === "warn"
        ? "bg-warning-bg text-warning-fg"
        : "bg-surface-alt text-fg-muted";
  return <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", cls)}>{label}</span>;
}
