"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Badge } from "@/ui/primitives/badge";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Textarea } from "@/ui/primitives/textarea";

/**
 * MCP servers pane on the project detail page.
 *
 * MCP fleet is per-project: list configured HTTP servers, add a new one
 * (name + URL + optional headers JSON), toggle enabled, or delete. Edits
 * land in `McpServerConfig` via direct `mcp.create` / `mcp.update` /
 * `mcp.delete` mutations — no proposal pipeline because there is no
 * provider write at stake. The agent loop reads this table at registry
 * build time (`src/agent/mcp/tools.ts`), so the next conversation turn
 * picks up changes without a server restart.
 *
 * Headers are entered as JSON text so the form stays one widget per
 * server. Invalid JSON blocks submit with an inline error rather than
 * throwing at the API.
 */
export function McpPane({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const list = trpc.mcp.list.useQuery({ projectId }, { staleTime: 0 });
  const create = trpc.mcp.create.useMutation({
    onSuccess: () => utils.mcp.list.invalidate({ projectId }),
  });
  const update = trpc.mcp.update.useMutation({
    onSuccess: () => utils.mcp.list.invalidate({ projectId }),
  });
  const remove = trpc.mcp.delete.useMutation({
    onSuccess: () => utils.mcp.list.invalidate({ projectId }),
  });

  const [draftName, setDraftName] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [draftHeaders, setDraftHeaders] = useState("");
  const [headersError, setHeadersError] = useState<string | null>(null);

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
    await create.mutateAsync({ projectId, name, url, headersJson, enabled: true });
    setDraftName("");
    setDraftUrl("");
    setDraftHeaders("");
  };

  return (
    <section className="flex flex-col gap-4">
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
          Exposes a remote MCP server's tools to the agent. The name is the tool prefix the agent
          sees; URL must speak SSE or streamable-HTTP MCP. Headers JSON (optional, string → string)
          is sent on every request — typical use is a bearer token or API key.
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
          No MCP servers configured. Add one above to expose remote tools to the agent.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.data?.map((s) => {
            const headers = (s.headersJson ?? {}) as Record<string, unknown>;
            const headerCount = Object.keys(headers).length;
            return (
              <li
                key={s.id}
                className="flex items-start justify-between gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{s.name}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {s.transport}
                    </span>
                    {!s.enabled && (
                      <Badge variant="secondary" className="uppercase tracking-wide">
                        disabled
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
                    disabled={update.isPending}
                    onClick={() =>
                      void update.mutateAsync({
                        projectId,
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
                    onClick={() => void remove.mutateAsync({ projectId, serverId: s.id })}
                  >
                    Delete
                  </Button>
                </div>
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
