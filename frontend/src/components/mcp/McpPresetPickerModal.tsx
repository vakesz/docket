import { ExternalLink, Sparkles, X } from "lucide-react";
import { useCallback, useState } from "react";

import type { DTO } from "~/api/client";
import { useApplyMcpPreset, useMcpPresets } from "~/api/hooks";
import { Label } from "~/components/common/Label";
import { Modal } from "~/components/common/Modal";
import { Notice } from "~/components/common/Notice";
import { cn } from "~/lib/cn";
import {
  fieldClass,
  fieldMonoClass,
  outlineButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "~/lib/formClasses";

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
    ? (selected.env ?? []).filter((e) => !envValues[e.name]?.trim()).map((e) => e.name)
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
    <Modal onClose={onClose} className="max-w-2xl">
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
          <Notice tone="error" title="Apply failed" className="mb-4">
            {apply.error.message}
          </Notice>
        )}

        {!selected ? (
          presets.isPending ? (
            <p className="text-sm text-fg-muted">Loading presets…</p>
          ) : presets.error ? (
            <Notice tone="error" title="Failed to load presets" className="mb-4">
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
                      <span className="truncate text-sm font-semibold text-fg">{preset.label}</span>
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
                className={cn(fieldClass, "mt-2")}
              />
              <p className="mt-1 text-xs text-fg-muted">
                Dict key in <code>config.toml</code>. Must be unique per project.
              </p>
            </div>

            {(selected.env ?? []).map((env) => (
              <div key={env.name}>
                <div className="flex items-center gap-2">
                  <Label>{env.name}</Label>
                  <span className="rounded-full bg-danger-bg px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-danger-fg">
                    required
                  </span>
                </div>
                <input
                  type="password"
                  value={envValues[env.name] ?? ""}
                  onChange={(e) =>
                    setEnvValues((prev) => ({ ...prev, [env.name]: e.target.value }))
                  }
                  placeholder={env.placeholder || env.name}
                  className={cn(fieldMonoClass, "mt-2")}
                />
                {env.description && <p className="mt-1 text-xs text-fg-muted">{env.description}</p>}
              </div>
            ))}

            <div className="flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                onClick={() => setEnabled((v) => !v)}
                className={secondaryButtonClass}
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
            <button type="button" onClick={backToList} className={outlineButtonClass}>
              Back
            </button>
            <button
              type="button"
              onClick={() => void onApply()}
              disabled={!canApply}
              className={primaryButtonClass}
            >
              <Sparkles className="h-4 w-4" />
              {apply.isPending ? "Applying…" : "Apply preset"}
            </button>
          </>
        ) : (
          <button type="button" onClick={onClose} className={outlineButtonClass}>
            Cancel
          </button>
        )}
      </footer>
    </Modal>
  );
}
