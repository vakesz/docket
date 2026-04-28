"use client";

import { useEffect, useState } from "react";
import {
  fieldClass,
  fieldMonoClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { Toggle } from "@/ui/primitives/toggle";

/**
 * Per-project knobs for the agent's web_fetch tool.
 *
 * Three keys live here:
 *   - `web-fetch.enabled` — kill switch. Off pulls the tool from the
 *     agent's registered tool list on the next conversation turn.
 *   - `web-fetch.allowed-hosts` — optional strict allowlist. Empty means
 *     any public (non-SSRF) host is reachable.
 *   - `web-fetch.max-bytes` — body cap before truncation.
 */
export function WebFetchPanel({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const projectSettings = trpc.settings.projectList.useQuery({ projectId });

  const [enabled, setEnabled] = useState(true);
  const [hostsText, setHostsText] = useState("");
  const [maxBytes, setMaxBytes] = useState<string>("1000000");

  useEffect(() => {
    if (!projectSettings.data) return;
    const lookup = new Map(projectSettings.data.map((row) => [row.key, row.value]));
    const e = lookup.get("web-fetch.enabled");
    const hosts = lookup.get("web-fetch.allowed-hosts");
    const m = lookup.get("web-fetch.max-bytes");
    if (typeof e === "boolean") setEnabled(e);
    if (Array.isArray(hosts)) setHostsText(hosts.join("\n"));
    if (typeof m === "number") setMaxBytes(String(m));
  }, [projectSettings.data]);

  const save = trpc.settings.projectUpdate.useMutation({
    onSuccess: async () => {
      await utils.settings.projectList.invalidate({ projectId });
    },
  });

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const hosts = hostsText
      .split(/\r?\n/)
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
    const maxBytesNum = Number.parseInt(maxBytes, 10);
    if (!Number.isFinite(maxBytesNum) || maxBytesNum < 64_000 || maxBytesNum > 8_000_000) return;
    await Promise.all([
      save.mutateAsync({ projectId, key: "web-fetch.enabled", value: enabled }),
      save.mutateAsync({ projectId, key: "web-fetch.allowed-hosts", value: hosts }),
      save.mutateAsync({ projectId, key: "web-fetch.max-bytes", value: maxBytesNum }),
    ]);
  };

  if (projectSettings.isPending) {
    return <p className="text-sm text-fg-faint">Loading…</p>;
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Toggle
          checked={enabled}
          disabled={save.isPending}
          onChange={setEnabled}
          label="Allow agent to fetch web pages"
        />
        <p className="text-xs text-fg-muted">
          When on, the agent can call web_fetch to read public URLs (RFCs, docs, changelogs).
          Private IPs and cloud metadata endpoints are blocked regardless of this flag.
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <label htmlFor="web-fetch-hosts" className="text-sm font-medium text-fg">
          Host allowlist
        </label>
        <p className="text-xs text-fg-muted">
          Optional strict allowlist, one hostname per line (e.g.{" "}
          <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">docs.python.org</code>).
          Leave empty to let the agent reach any public host.
        </p>
        <textarea
          id="web-fetch-hosts"
          value={hostsText}
          disabled={save.isPending}
          onChange={(e) => setHostsText(e.target.value)}
          rows={5}
          placeholder="docs.python.org&#10;learn.microsoft.com&#10;www.rfc-editor.org"
          className={`${fieldMonoClass} max-w-xl text-xs`}
        />
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <label htmlFor="web-fetch-max-bytes" className="text-sm font-medium text-fg">
          Response size cap (bytes)
        </label>
        <p className="text-xs text-fg-muted">
          Larger payloads are truncated and reported as denied_size. Range: 64 000 to 8 000 000.
          Default 1 000 000 (~1 MB).
        </p>
        <input
          id="web-fetch-max-bytes"
          type="number"
          inputMode="numeric"
          min={64_000}
          max={8_000_000}
          step={1_000}
          value={maxBytes}
          disabled={save.isPending}
          onChange={(e) => setMaxBytes(e.target.value)}
          className={`${fieldClass} max-w-[12rem]`}
        />
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={save.isPending} className={primaryButtonClass}>
          {save.isPending ? "Saving…" : "Save web-fetch settings"}
        </button>
        <button
          type="button"
          disabled={save.isPending}
          className={secondaryButtonClass}
          onClick={() => {
            setEnabled(true);
            setHostsText("");
            setMaxBytes("1000000");
          }}
        >
          Reset to defaults
        </button>
        {save.error ? <span className="text-xs text-danger-fg">{save.error.message}</span> : null}
        {save.isSuccess ? <span className="text-xs text-fg-muted">Saved.</span> : null}
      </div>
    </form>
  );
}
