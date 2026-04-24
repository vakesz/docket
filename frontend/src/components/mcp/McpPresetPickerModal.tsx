import { CheckCircle2, CircleAlert, ExternalLink, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { DTO } from "~/api/client";
import { useApplyMcpPreset, useMcpPresets } from "~/api/hooks";
import { cn } from "~/lib/cn";

/**
 * Preset picker. Two steps:
 *
 *   1. Browse the catalog returned by `GET /mcp/presets`.
 *   2. Fill in the selected preset's required env vars and submit
 *      `POST /projects/{id}/mcp/presets/{preset_id}/apply`.
 *
 * Names are editable so the user can disambiguate multiple instances of the
 * same preset (e.g. two GitHub accounts). Backend enforces uniqueness per
 * project.
 */
export function McpPresetPickerModal({
  projectId,
  onClose,
  onApplied,
}: {
  projectId: string;
  onClose: () => void;
  onApplied: (name: string) => void;
}) {
  const presets = useMcpPresets();
  const apply = useApplyMcpPreset(projectId);
  const [selected, setSelected] = useState<DTO["MCPPresetDTO"] | null>(null);
  const [name, setName] = useState("");
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(true);

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickPreset = (preset: DTO["MCPPresetDTO"]) => {
    setSelected(preset);
    setName(preset.default_name);
    const seed: Record<string, string> = {};
    for (const env of preset.env ?? []) {
      seed[env.name] = "";
    }
    setEnvValues(seed);
    setEnabled(true);
    apply.reset();
  };

  const backToList = () => {
    setSelected(null);
    setName("");
    setEnvValues({});
    apply.reset();
  };

  const missingRequired = selected
    ? (selected.env ?? [])
        .filter((e) => e.required && !envValues[e.name]?.trim())
        .map((e) => e.name)
    : [];

  const canApply =
    !!selected && name.trim().length > 0 && missingRequired.length === 0 && !apply.isPending;

  const onApply = useCallback(async () => {
    if (!selected || !canApply) return;
    const cleanedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(envValues)) {
      const trimmed = v.trim();
      if (trimmed) cleanedEnv[k] = trimmed;
    }
    const body: DTO["MCPPresetApplyRequest"] = {
      name: name.trim(),
      env: cleanedEnv,
      enabled,
    };
    const created = await apply.mutateAsync({ presetId: selected.id, body });
    onApplied(created.name);
  }, [apply, canApply, enabled, envValues, name, onApplied, selected]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl">
        <header className="flex items-center gap-3 border-b border-border px-6 py-4">
          <div className="rounded-xl bg-accent/10 p-2 text-accent">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-fg">
              {selected ? `Apply preset — ${selected.label}` : "Pick an MCP preset"}
            </h2>
            <p className="truncate text-xs text-fg-muted">
              {selected
                ? "Fill in the required env vars and create the server."
                : "Known-good recipes the backend can instantiate for you."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-1.5 text-fg-muted hover:bg-surface-alt"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-auto px-6 py-5">
          {apply.error && (
            <Notice tone="error" title="Apply failed">
              {apply.error.message}
            </Notice>
          )}

          {!selected ? (
            presets.isPending ? (
              <p className="text-sm text-fg-muted">Loading presets…</p>
            ) : presets.error ? (
              <Notice tone="error" title="Failed to load presets">
                {presets.error.message}
              </Notice>
            ) : presets.data?.presets?.length ? (
              <ul className="flex flex-col gap-2">
                {presets.data.presets.map((preset) => (
                  <li key={preset.id}>
                    <button
                      type="button"
                      onClick={() => pickPreset(preset)}
                      className="flex w-full flex-col items-start gap-1 rounded-xl border border-border bg-bg px-4 py-3 text-left transition-colors hover:border-accent hover:bg-accent/5"
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="truncate text-sm font-semibold text-fg">
                          {preset.label}
                        </span>
                        <span className="font-mono text-[10px] text-fg-muted">{preset.id}</span>
                      </div>
                      <p className="text-xs text-fg-muted">{preset.description}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
                        <span className="font-mono">
                          {preset.command} {preset.args?.join(" ")}
                        </span>
                        {preset.docs_url && (
                          <a
                            href={preset.docs_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-accent hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink className="h-3 w-3" />
                            docs
                          </a>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-fg-muted">No presets registered.</p>
            )
          ) : (
            <div className="flex flex-col gap-5">
              <div>
                <Label>Server name</Label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={selected.default_name}
                  className="mt-2 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
                />
                <p className="mt-1 text-xs text-fg-muted">
                  Dict key in <code>config.toml</code>. Must be unique per project.
                </p>
              </div>

              {(selected.env ?? []).map((env) => (
                <div key={env.name}>
                  <div className="flex items-center gap-2">
                    <Label>{env.name}</Label>
                    {env.required && (
                      <span className="rounded-full bg-danger-bg px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-danger-fg">
                        required
                      </span>
                    )}
                  </div>
                  <input
                    type="password"
                    value={envValues[env.name] ?? ""}
                    onChange={(e) =>
                      setEnvValues((prev) => ({ ...prev, [env.name]: e.target.value }))
                    }
                    placeholder={env.placeholder || env.name}
                    className="mt-2 w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
                  />
                  {env.description && (
                    <p className="mt-1 text-xs text-fg-muted">{env.description}</p>
                  )}
                </div>
              ))}

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  onClick={() => setEnabled((v) => !v)}
                  className="inline-flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg hover:bg-surface-alt"
                >
                  <span
                    className={cn(
                      "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                      enabled ? "bg-accent" : "bg-surface-alt",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-block h-4 w-4 transform rounded-full bg-surface shadow transition-transform",
                        enabled ? "translate-x-4" : "translate-x-0.5",
                      )}
                    />
                  </span>
                  <span>{enabled ? "Enabled on create" : "Disabled on create"}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border bg-surface/70 px-6 py-3">
          {selected ? (
            <>
              <button
                type="button"
                onClick={backToList}
                className="rounded-xl border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-bg"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => void onApply()}
                disabled={!canApply}
                className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Sparkles className="h-4 w-4" />
                {apply.isPending ? "Applying…" : "Apply preset"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-bg"
            >
              Cancel
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-muted">
      {children}
    </span>
  );
}

function Notice({
  title,
  children,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  tone: "error" | "warning";
}) {
  return (
    <div
      className={cn(
        "mb-4 rounded-2xl border px-4 py-3 text-sm",
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
