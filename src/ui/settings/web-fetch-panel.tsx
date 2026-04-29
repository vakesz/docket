"use client";

import { useEffect, useId, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { Switch } from "@/ui/primitives/switch";
import { Textarea } from "@/ui/primitives/textarea";

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
export function WebFetchPanel({ projectSlug }: { projectSlug: string }) {
  const utils = trpc.useUtils();
  const projectSettings = trpc.settings.projectList.useQuery({ projectSlug });

  const [enabled, setEnabled] = useState(true);
  const [hostsText, setHostsText] = useState("");
  const [maxBytes, setMaxBytes] = useState<string>("1000000");

  const enabledId = useId();
  const hostsId = useId();
  const maxBytesId = useId();

  // Seed once per project. Parallel mutateAsync calls below would
  // otherwise let an intermediate refetch (after one mutation lands but
  // before the others) clobber whatever the user is still editing.
  // Switching projects in-place must re-seed from the new project's
  // settings instead of keeping the previous project's state.
  const seededForRef = useRef<string | null>(null);
  useEffect(() => {
    if (seededForRef.current === projectSlug) return;
    if (!projectSettings.data) return;
    const lookup = new Map(projectSettings.data.map((row) => [row.key, row.value]));
    const e = lookup.get("web-fetch.enabled");
    const hosts = lookup.get("web-fetch.allowed-hosts");
    const m = lookup.get("web-fetch.max-bytes");
    setEnabled(typeof e === "boolean" ? e : true);
    setHostsText(Array.isArray(hosts) ? hosts.join("\n") : "");
    setMaxBytes(typeof m === "number" ? String(m) : "1000000");
    seededForRef.current = projectSlug;
  }, [projectSettings.data, projectSlug]);

  const save = trpc.settings.projectUpdate.useMutation({
    onSuccess: async () => {
      await utils.settings.projectList.invalidate({ projectSlug });
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
      save.mutateAsync({ projectSlug, key: "web-fetch.enabled", value: enabled }),
      save.mutateAsync({ projectSlug, key: "web-fetch.allowed-hosts", value: hosts }),
      save.mutateAsync({ projectSlug, key: "web-fetch.max-bytes", value: maxBytesNum }),
    ]);
  };

  if (projectSettings.isPending) {
    return <p className="text-sm text-muted-foreground-faint">Loading…</p>;
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm text-foreground">
          <Switch
            id={enabledId}
            checked={enabled}
            disabled={save.isPending}
            onCheckedChange={setEnabled}
          />
          <Label htmlFor={enabledId}>Allow agent to fetch web pages</Label>
        </div>
        <p className="text-xs text-muted-foreground">
          When on, the agent can call web_fetch to read public URLs (RFCs, docs, changelogs).
          Private IPs and cloud metadata endpoints are blocked regardless of this flag.
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <Label htmlFor={hostsId} className="text-sm font-medium text-foreground">
          Host allowlist
        </Label>
        <p className="text-xs text-muted-foreground">
          Optional strict allowlist, one hostname per line (e.g.{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">docs.python.org</code>). Leave
          empty to let the agent reach any public host.
        </p>
        <Textarea
          id={hostsId}
          value={hostsText}
          disabled={save.isPending}
          onChange={(e) => setHostsText(e.target.value)}
          rows={5}
          placeholder="docs.python.org&#10;learn.microsoft.com&#10;www.rfc-editor.org"
          className="max-w-xl font-mono text-xs"
        />
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <Label htmlFor={maxBytesId} className="text-sm font-medium text-foreground">
          Response size cap (bytes)
        </Label>
        <p className="text-xs text-muted-foreground">
          Larger payloads are truncated and reported as denied_size. Range: 64 000 to 8 000 000.
          Default 1 000 000 (~1 MB).
        </p>
        <Input
          id={maxBytesId}
          type="number"
          inputMode="numeric"
          min={64_000}
          max={8_000_000}
          step={1_000}
          value={maxBytes}
          disabled={save.isPending}
          onChange={(e) => setMaxBytes(e.target.value)}
          className="max-w-[12rem]"
        />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save web-fetch settings"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={save.isPending}
          onClick={() => {
            setEnabled(true);
            setHostsText("");
            setMaxBytes("1000000");
          }}
        >
          Reset to defaults
        </Button>
        {save.error ? <span className="text-xs text-destructive">{save.error.message}</span> : null}
        {save.isSuccess ? <span className="text-xs text-muted-foreground">Saved.</span> : null}
      </div>
    </form>
  );
}
