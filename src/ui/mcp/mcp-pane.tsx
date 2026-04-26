"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";

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
    <section className="flex flex-col gap-3 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          MCP servers
        </h2>
        <span className="text-xs text-muted-foreground">{list.data?.length ?? 0} configured</span>
      </header>

      <form
        className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-muted/20 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submitNew();
        }}
      >
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="server-name (lowercase, '-' or '_')"
            className="flex-1 rounded-md border border-border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            maxLength={64}
            pattern="[a-z0-9][a-z0-9_-]*"
          />
          <input
            type="url"
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            placeholder="https://mcp.example.com/sse"
            className="flex-[2] rounded-md border border-border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            maxLength={500}
          />
        </div>
        <textarea
          value={draftHeaders}
          onChange={(e) => setDraftHeaders(e.target.value)}
          placeholder='Optional headers JSON, e.g. {"Authorization": "Bearer ..."}'
          rows={2}
          className="rounded-md border border-border bg-background p-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex items-center justify-end">
          <Button
            type="submit"
            size="sm"
            disabled={create.isPending || !draftName.trim() || !draftUrl.trim()}
          >
            {create.isPending ? "Adding…" : "Add server"}
          </Button>
        </div>
        {headersError && <p className="text-xs text-destructive">{headersError}</p>}
        {create.error && <p className="text-xs text-destructive">{create.error.message}</p>}
      </form>

      {list.isPending ? (
        <p className="text-sm italic text-muted-foreground">Loading MCP servers…</p>
      ) : list.data?.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">
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
                className="flex items-start justify-between gap-3 rounded-md border border-border bg-background p-3"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{s.name}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {s.transport}
                    </span>
                    {!s.enabled && (
                      <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                        disabled
                      </span>
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
                    size="sm"
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
                    size="sm"
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

      {update.error && <p className="text-xs text-destructive">{update.error.message}</p>}
      {remove.error && <p className="text-xs text-destructive">{remove.error.message}</p>}
    </section>
  );
}
