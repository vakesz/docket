import { CheckCircle2, CircleAlert, FlaskConical, Plus, Save, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { DTO } from "~/api/client";
import {
  useCreateMcpServer,
  useDeleteMcpServer,
  useTestMcpServer,
  useUpdateMcpServer,
} from "~/api/hooks";
import { FieldError, FormField } from "~/components/common/FormField";
import { NumberInput, Select, StatusPill, TextInput } from "~/components/common/FormInputs";
import { Notice } from "~/components/common/Notice";
import { Toggle } from "~/components/common/Toggle";
import { draftsEqual, type McpServerDraft, serializeDraft } from "~/components/mcp/mcpServerDraft";
import { cn } from "~/lib/cn";
import { dangerButtonClass, outlineButtonClass, primaryButtonClass } from "~/lib/formClasses";

// Server names act as dict keys in `config.toml` under `[projects.<id>.mcp.<name>]`;
// the backend also enforces the same shape (`tui_parity.validate_mcp_server_name`).
// We validate client-side too so users get feedback before a roundtrip.
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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
  const testServer = useTestMcpServer(projectId);

  const [draft, setDraft] = useState<McpServerDraft>(initialDraft);
  const [testResult, setTestResult] = useState<DTO["MCPServerTestResultDTO"] | null>(null);

  // Reset the form when the caller swaps to a different entry (or mode).
  // biome-ignore lint/correctness/useExhaustiveDependencies: swapping driven by initialDraft identity, not live mutations.
  useEffect(() => {
    setDraft(initialDraft);
    setTestResult(null);
    create.reset();
    update.reset();
    del.reset();
    testServer.reset();
  }, [initialDraft]);

  const nameError = useMemo(() => {
    if (mode !== "create") return null;
    const trimmed = draft.name.trim();
    if (!trimmed) return "Name is required.";
    if (!NAME_PATTERN.test(trimmed)) {
      return "Name must start with a letter/digit and contain only letters, digits, _ or - (max 64 chars).";
    }
    return null;
  }, [draft.name, mode]);

  const isStdio = draft.transport === "stdio";
  const commandError =
    isStdio && draft.command.trim().length === 0 ? "Command is required for stdio." : null;
  const urlError =
    !isStdio && draft.url.trim().length === 0
      ? `URL is required for the ${draft.transport} transport.`
      : null;
  const timeoutError =
    !Number.isFinite(draft.startup_timeout_seconds) || draft.startup_timeout_seconds <= 0
      ? "Startup timeout must be greater than 0."
      : null;

  const formError = nameError || commandError || urlError || timeoutError;
  // `Test` only needs the transport-specific endpoint, not the timeout. So
  // gate it on the field that drives the connection rather than `formError`.
  const testBlockedReason = isStdio ? commandError : urlError;

  const dirty = useMemo(() => !draftsEqual(draft, initialDraft), [draft, initialDraft]);

  const save = useCallback(async () => {
    if (readOnly || formError) return;
    const body = serializeDraft(draft);
    if (mode === "create") {
      const created = await create.mutateAsync({ name: draft.name.trim(), body });
      onCreated?.(created.name);
    } else {
      const patch: DTO["MCPServerUpdateRequest"] = {
        command: body.command,
        args: body.args,
        env: body.env,
        url: body.url,
        headers: body.headers,
        transport: body.transport,
        enabled: body.enabled,
        startup_timeout_seconds: body.startup_timeout_seconds,
      };
      await update.mutateAsync({ name: initialDraft.name, body: patch });
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
    if (readOnly || testBlockedReason) return;
    setTestResult(null);
    // For a saved-and-untouched server, omit the body so the backend exercises
    // the runtime fleet's live client config rather than re-binding a throwaway
    // client. For drafts and dirty edits, send the in-flight config.
    const sendBody = mode === "create" || dirty;
    const name = mode === "edit" ? initialDraft.name : draft.name.trim() || "draft";
    const result = await testServer.mutateAsync({
      name,
      body: sendBody ? serializeDraft(draft) : undefined,
    });
    setTestResult(result);
  }, [testBlockedReason, dirty, draft, initialDraft.name, mode, readOnly, testServer]);

  const saving = create.isPending || update.isPending;
  const testing = testServer.isPending;
  const deleting = del.isPending;
  const saveError = create.error ?? update.error;
  const deleteError = del.error;
  const testError = testServer.error;

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
      <header className="border-b border-border bg-surface/70 px-6 py-4 backdrop-blur">
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
            ? "MCP server (stdio subprocess or remote http/sse endpoint) that exposes tools to the agent. Names are immutable once saved."
            : "Edit the server config. Changes rebind the live client on save."}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
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

            <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
              <FormField
                label="Transport"
                help={
                  isStdio
                    ? "Local subprocess speaking MCP over stdio."
                    : draft.transport === "http"
                      ? "Remote streamable-HTTP MCP endpoint (e.g. hosted GitHub MCP)."
                      : "Remote MCP endpoint over Server-Sent Events."
                }
              >
                <Select
                  value={draft.transport}
                  options={[
                    { value: "stdio", label: "stdio (subprocess)" },
                    { value: "http", label: "http (streamable HTTP)" },
                    { value: "sse", label: "sse (server-sent events)" },
                  ]}
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

            {isStdio ? (
              <>
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

                <FormField
                  label="Environment"
                  help="Key/value pairs forwarded to the subprocess. Use for secrets like API tokens."
                >
                  <PairEditor
                    value={draft.env}
                    onChange={(next) => setDraft((d) => ({ ...d, env: next }))}
                    keyPlaceholder="GITHUB_PERSONAL_ACCESS_TOKEN"
                    valuePlaceholder="ghp_…"
                    valueType="password"
                    addLabel="Add env var"
                    emptyLabel="No env vars set."
                  />
                </FormField>
              </>
            ) : (
              <>
                <FormField
                  label="URL"
                  help={
                    draft.transport === "http"
                      ? "Streamable-HTTP endpoint (usually ends in /mcp)."
                      : "SSE endpoint URL."
                  }
                >
                  <TextInput
                    value={draft.url}
                    onChange={(v) => setDraft((d) => ({ ...d, url: v }))}
                    placeholder={
                      draft.transport === "http"
                        ? "https://api.example.com/mcp"
                        : "https://api.example.com/sse"
                    }
                  />
                  {urlError && <FieldError>{urlError}</FieldError>}
                </FormField>

                <FormField
                  label="Headers"
                  help="Sent on every request. Use for `Authorization: Bearer …` and the like."
                >
                  <PairEditor
                    value={draft.headers}
                    onChange={(next) => setDraft((d) => ({ ...d, headers: next }))}
                    keyPlaceholder="Authorization"
                    valuePlaceholder="Bearer …"
                    valueType="password"
                    addLabel="Add header"
                    emptyLabel="No headers set."
                  />
                </FormField>
              </>
            )}

            <FormField label="Enabled" help="Disabled servers are skipped at bind time.">
              <Toggle
                checked={draft.enabled}
                onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
                label={draft.enabled ? "Enabled" : "Disabled"}
              />
            </FormField>
          </section>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void onTest()}
              disabled={readOnly || testing || Boolean(testBlockedReason)}
              className={outlineButtonClass}
              title={
                isStdio
                  ? "Spawn the subprocess, run the MCP handshake, and list its tools"
                  : "Open a connection to the remote MCP server, run the handshake, and list its tools"
              }
            >
              <FlaskConical className="h-4 w-4" />
              {testing ? "Testing…" : "Test"}
            </button>
            {mode === "edit" && (
              <button
                type="button"
                onClick={() => void onDelete()}
                disabled={readOnly || deleting}
                className={dangerButtonClass}
              >
                <Trash2 className="h-4 w-4" />
                {deleting ? "Deleting…" : "Delete"}
              </button>
            )}
            <button
              type="button"
              onClick={() => void save()}
              disabled={readOnly || saving || Boolean(formError) || (mode === "edit" && !dirty)}
              className={primaryButtonClass}
            >
              <Save className="h-4 w-4" />
              {saving ? "Saving…" : mode === "create" ? "Create" : "Save changes"}
              <span className="ml-1 hidden font-mono text-[10px] opacity-70 sm:inline">⌘S</span>
            </button>
          </div>
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

function PairEditor({
  value,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  valueType,
  addLabel,
  emptyLabel,
}: {
  value: { key: string; value: string }[];
  onChange: (next: { key: string; value: string }[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  valueType?: "text" | "password";
  addLabel: string;
  emptyLabel: string;
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
          {emptyLabel}
        </p>
      )}
      {value.map((row, idx) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: pair rows are ordered and the index is a stable identity while the row is mounted; swapping to random ids would force remount on every keystroke.
          key={idx}
          className="grid grid-cols-[1fr_1.5fr_auto] items-stretch gap-2"
        >
          <TextInput
            value={row.key}
            onChange={(v) => updateRow(idx, { key: v })}
            placeholder={keyPlaceholder}
          />
          <TextInput
            value={row.value}
            onChange={(v) => updateRow(idx, { value: v })}
            placeholder={valuePlaceholder}
            type={valueType ?? "text"}
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
        {addLabel}
      </button>
    </div>
  );
}
