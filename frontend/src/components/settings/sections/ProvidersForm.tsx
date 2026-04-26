import { Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";

import { useRemoveProvider } from "~/api/hooks";
import { Select } from "~/components/common/FormInputs";
import { Label } from "~/components/common/Label";
import { Notice } from "~/components/common/Notice";
import { cn } from "~/lib/cn";

import { asRecord, getString, providerLabel } from "../_helpers";
import type { ConfigMap } from "../_types";
import { ProviderModal } from "../ProviderModal";

export function ProvidersForm({
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

  const [showAdd, setShowAdd] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const remove = useRemoveProvider();
  const [removeError, setRemoveError] = useState<string | null>(null);

  const onRemove = (key: string) => {
    if (key === initialActive) {
      setRemoveError(
        `Cannot remove '${key}' — it is the currently-active provider. Switch to another provider first (save the change, restart), then remove.`,
      );
      return;
    }
    if (!window.confirm(`Remove provider "${key}"? This cannot be undone.`)) return;
    setRemoveError(null);
    remove.mutate(key, {
      onError: (err) => setRemoveError((err as Error).message),
    });
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label>Active provider</Label>
        {providerKeys.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-2 text-sm text-fg-muted">
            No providers configured. Add one below to get started.
          </p>
        ) : (
          <Select
            value={active}
            options={providerKeys.map((k) => ({ value: k, label: providerLabel(providers[k], k) }))}
            onChange={(v) => onChange((cur) => ({ ...cur, _active: v }))}
          />
        )}
        <p className="text-xs text-fg-muted">
          Which configured backend Docket opens with at startup.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <Label>Configured providers</Label>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface-alt"
          >
            <Plus className="h-3.5 w-3.5" />
            Add provider
          </button>
        </div>
        <p className="text-xs text-fg-muted">
          Add, test, and remove providers here. Credentials for existing providers still live in{" "}
          <code>config.toml</code> — use Raw JSON mode to edit them in-place.
        </p>
        {removeError && (
          <Notice tone="error" title="Remove failed">
            {removeError}
          </Notice>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {providerKeys.length === 0 ? (
            <div className="text-sm text-fg-muted">None.</div>
          ) : (
            providerKeys.map((k) => {
              const entry = asRecord(providers[k]) ?? {};
              const type = getString(entry, "type") ?? "unknown";
              const display = getString(entry, "display_name") ?? k;
              const activeView = getString(entry, "active_view") ?? "default";
              const views = asRecord(entry.views);
              const viewCount = views ? Object.keys(views).length : 0;
              const isActive = k === active;
              const isRuntimeActive = k === initialActive;
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
                    <div className="flex items-center gap-1">
                      {isActive && (
                        <span className="rounded-full bg-accent/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent">
                          active
                        </span>
                      )}
                      {!isActive && (
                        <button
                          type="button"
                          onClick={() => onChange((cur) => ({ ...cur, _active: k }))}
                          title="Make this the active provider — Docket will open with it at startup."
                          className="inline-flex items-center rounded-lg p-1 text-fg-muted hover:bg-surface-alt hover:text-accent"
                        >
                          <Star className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditingKey(k)}
                        title={`Edit provider '${k}'`}
                        className="inline-flex items-center rounded-lg p-1 text-fg-muted hover:bg-surface-alt hover:text-fg"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemove(k)}
                        disabled={isRuntimeActive || remove.isPending}
                        title={
                          isRuntimeActive
                            ? "Cannot remove the currently-active provider."
                            : `Remove provider '${k}'`
                        }
                        className="inline-flex items-center rounded-lg p-1 text-fg-muted hover:bg-surface-alt hover:text-danger disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-fg-muted">
                    {k} · {type}
                  </div>
                  <div className="mt-1 text-xs text-fg-muted">
                    {viewCount === 1
                      ? `1 view: “${activeView}”`
                      : `${viewCount} views · selected: “${activeView}”`}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {showAdd && (
        <ProviderModal
          mode="add"
          existingKeys={providerKeys}
          onClose={() => setShowAdd(false)}
          onSaved={() => setShowAdd(false)}
        />
      )}
      {editingKey && providers[editingKey] ? (
        <ProviderModal
          mode="edit"
          existingKeys={providerKeys}
          existingKey={editingKey}
          existingEntry={asRecord(providers[editingKey]) ?? {}}
          onClose={() => setEditingKey(null)}
          onSaved={() => setEditingKey(null)}
        />
      ) : null}
    </>
  );
}
