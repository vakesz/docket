"use client";

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Badge } from "@/ui/primitives/badge";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Textarea } from "@/ui/primitives/textarea";
import { McpServerEditor } from "./server-editor";
import { McpTemplatePicker } from "./template-picker";
import { findTemplateByUrl, templateHeadersComplete } from "./templates";

/**
 * MCP servers pane on the project detail page.
 *
 * MCP fleet is per-project: list configured HTTP servers, add a new one
 * (template chip or free-form name + URL + headers), edit any row's URL
 * and headers, toggle enabled, or delete. Templates land disabled with
 * empty headers — the user opens the row's editor to fill in credentials
 * (or kick off the OAuth flow) before enabling.
 *
 * Headers are encrypted at rest via `headers-codec.ts`; the agent loop
 * reads this table at registry build time, so the next conversation turn
 * picks up changes without a server restart.
 */
export function McpPane({ projectSlug }: { projectSlug: string }) {
  const utils = trpc.useUtils();
  const list = trpc.mcp.list.useQuery({ projectSlug }, { staleTime: 0 });
  const create = trpc.mcp.create.useMutation({
    onSuccess: () => utils.mcp.list.invalidate({ projectSlug }),
  });
  const update = trpc.mcp.update.useMutation({
    onSuccess: () => utils.mcp.list.invalidate({ projectSlug }),
  });
  const remove = trpc.mcp.delete.useMutation({
    onSuccess: () => utils.mcp.list.invalidate({ projectSlug }),
  });

  const [draftName, setDraftName] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [draftHeaders, setDraftHeaders] = useState("");
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const existingNames = useMemo(() => new Set((list.data ?? []).map((s) => s.name)), [list.data]);

  const submitNew = async () => {
    const name = draftName.trim();
    const url = draftUrl.trim();
    if (!name || !url) return;
    let headersJson: Record<string, string> = {};
    if (draftHeaders.trim()) {
      try {
        const parsed = JSON.parse(draftHeaders);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed) ||
          Object.values(parsed).some((v) => typeof v !== "string")
        ) {
          setHeadersError("Headers must be a JSON object of string → string.");
          return;
        }
        headersJson = parsed as Record<string, string>;
      } catch (err) {
        setHeadersError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    setHeadersError(null);
    await create.mutateAsync({ projectSlug, name, url, headersJson, enabled: true });
    setDraftName("");
    setDraftUrl("");
    setDraftHeaders("");
  };

  return (
    <section className="flex flex-col gap-4">
      <McpTemplatePicker projectSlug={projectSlug} existingNames={existingNames} />

      <form
        className="flex flex-col gap-2 rounded-2xl border border-dashed border-border bg-muted/40 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submitNew();
        }}
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Input
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="server-name (lowercase, '-' or '_')"
              maxLength={64}
              pattern="[a-z0-9][a-z0-9_-]*"
            />
          </div>
          <div className="min-w-0 flex-[2]">
            <Input
              type="url"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              placeholder="https://mcp.example.com/sse"
              maxLength={500}
            />
          </div>
        </div>
        <Textarea
          value={draftHeaders}
          onChange={(e) => setDraftHeaders(e.target.value)}
          placeholder='Optional headers JSON, e.g. {"Authorization": "Bearer ..."}'
          rows={2}
          className="font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Add a custom MCP server. The name is the tool prefix the agent sees; URL must speak SSE or
          streamable-HTTP MCP. Headers JSON (optional, string → string) is sent on every request and
          is encrypted at rest.
        </p>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{list.data?.length ?? 0} configured</span>
          <Button
            type="submit"
            size="xs"
            disabled={create.isPending || !draftName.trim() || !draftUrl.trim()}
          >
            {create.isPending ? "Adding…" : "Add server"}
          </Button>
        </div>
        {headersError && (
          <Alert variant="destructive">
            <AlertDescription>{headersError}</AlertDescription>
          </Alert>
        )}
        {create.error && (
          <Alert variant="destructive">
            <AlertDescription>{create.error.message}</AlertDescription>
          </Alert>
        )}
      </form>

      {list.isPending ? (
        <p className="text-sm italic text-muted-foreground">Loading MCP servers…</p>
      ) : list.data?.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          No MCP servers configured. Pick a template above or add a custom server.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.data?.map((s) => {
            const headers = s.headersJson;
            const headerCount = Object.keys(headers).length;
            const template = findTemplateByUrl(s.url);
            const needsConfig = template ? !templateHeadersComplete(template, headers) : false;
            const isEditing = editingId === s.id;
            return (
              <li
                key={s.id}
                className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{s.name}</span>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {s.transport}
                      </span>
                      {!s.enabled && (
                        <Badge variant="secondary" className="uppercase tracking-wide">
                          disabled
                        </Badge>
                      )}
                      {s.hasOauth && (
                        <Badge variant="secondary" className="uppercase tracking-wide">
                          oauth
                        </Badge>
                      )}
                      {needsConfig && (
                        <Badge
                          variant="secondary"
                          className="border-amber-500/40 bg-amber-500/15 uppercase tracking-wide text-amber-700 dark:text-amber-300"
                        >
                          needs config
                        </Badge>
                      )}
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground">{s.url}</p>
                    {headerCount > 0 && (
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {headerCount} header{headerCount === 1 ? "" : "s"}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => setEditingId(isEditing ? null : s.id)}
                    >
                      {isEditing ? "Close" : "Edit"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={update.isPending || (needsConfig && !s.enabled)}
                      onClick={() =>
                        void update.mutateAsync({
                          projectSlug,
                          serverId: s.id,
                          enabled: !s.enabled,
                        })
                      }
                    >
                      {s.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="xs"
                      disabled={remove.isPending}
                      onClick={() => void remove.mutateAsync({ projectSlug, serverId: s.id })}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                {isEditing && (
                  <McpServerEditor
                    projectSlug={projectSlug}
                    row={{
                      id: s.id,
                      name: s.name,
                      url: s.url,
                      headersJson: headers,
                      enabled: s.enabled,
                      hasOauth: s.hasOauth,
                    }}
                    onClose={() => setEditingId(null)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {update.error && (
        <Alert variant="destructive">
          <AlertDescription>{update.error.message}</AlertDescription>
        </Alert>
      )}
      {remove.error && (
        <Alert variant="destructive">
          <AlertDescription>{remove.error.message}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
