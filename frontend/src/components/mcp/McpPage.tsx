import { Plus, ServerCog, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { DTO } from "~/api/client";
import { useActiveProject, useMcpServers, useStatus } from "~/api/hooks";
import { ListPlaceholder } from "~/components/common/ListPlaceholder";
import { cn } from "~/lib/cn";
import { sidebarActionClass } from "~/lib/formClasses";

import { McpPresetPickerModal } from "./McpPresetPickerModal";
import { McpServerForm } from "./McpServerForm";
import { blankDraft, draftFromServer, type McpServerDraft } from "./mcpServerDraft";

/**
 * MCP page: left column lists the active project's configured servers,
 * right column edits the selected one (or a fresh draft). The TUI version
 * (`src/docket/cli/tui/widgets/mcp_pane.py`) is the design reference.
 *
 * Selection model: `selectedName` is either an existing server's name or the
 * sentinel `null` which means "draft a new server". We rely on names being
 * immutable after create, so selection stays valid across refetches.
 */
export function McpPage() {
  const activeProject = useActiveProject();
  const status = useStatus();
  const projectId = activeProject.data?.id;
  const servers = useMcpServers(projectId);
  const readOnly = status.data?.read_only ?? false;

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showPresets, setShowPresets] = useState(false);

  const entries = useMemo(
    () => [...(servers.data?.entries ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [servers.data?.entries],
  );

  // Auto-select the first entry on load, unless the user is drafting a new one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally skip `creating` — a new draft must not nudge us back to an existing entry while the form is open.
  useEffect(() => {
    if (creating) return;
    if (entries.length === 0) {
      setSelectedName(null);
      return;
    }
    if (selectedName && entries.some((e) => e.name === selectedName)) return;
    setSelectedName(entries[0]?.name ?? null);
  }, [entries, selectedName]);

  const selectedEntry = entries.find((e) => e.name === selectedName) ?? null;

  // Memoize so the form's reset effect (keyed on identity) only fires when the
  // user actually swaps entries or toggles creating, not on unrelated re-renders.
  const draft = useMemo<McpServerDraft>(
    () => (creating ? blankDraft() : selectedEntry ? draftFromServer(selectedEntry) : blankDraft()),
    [creating, selectedEntry],
  );

  const startNewDraft = () => {
    if (readOnly) return;
    setCreating(true);
    setSelectedName(null);
  };

  const onSelect = (name: string) => {
    setCreating(false);
    setSelectedName(name);
  };

  const onDeleted = () => {
    setCreating(false);
    setSelectedName(null);
  };

  const onCreated = (name: string) => {
    setCreating(false);
    setSelectedName(name);
  };

  if (activeProject.isPending || status.isPending) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-muted">Loading…</div>
    );
  }
  if (activeProject.error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-danger">
        {activeProject.error.message}
      </div>
    );
  }
  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-fg-muted">
        No active project.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-bg">
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)]">
        {/* ---- Sidebar ---- */}
        <aside className="flex min-h-0 flex-col overflow-hidden border-b border-border bg-surface/80 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-2 border-b border-border px-4 py-4">
            <div className="rounded-xl bg-accent/10 p-2 text-accent">
              <ServerCog className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-fg">MCP servers</h1>
              <p className="truncate text-[11px] text-fg-muted">
                Project <code className="font-mono">{projectId}</code>
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2 px-3 py-3">
            <button
              type="button"
              onClick={startNewDraft}
              disabled={readOnly}
              className={sidebarActionClass}
              title={readOnly ? "Read-only mode" : "Add a new MCP server"}
            >
              <Plus className="h-4 w-4" />
              New server
            </button>
            <button
              type="button"
              onClick={() => setShowPresets(true)}
              disabled={readOnly}
              className={sidebarActionClass}
              title={readOnly ? "Read-only mode" : "Pick from known-good server recipes"}
            >
              <Sparkles className="h-4 w-4" />
              Apply preset
            </button>
          </div>

          <nav className="min-h-0 flex-1 overflow-auto px-2 pb-3">
            {servers.isPending ? (
              <ListPlaceholder>Loading servers…</ListPlaceholder>
            ) : servers.error ? (
              <ListPlaceholder tone="error">{servers.error.message}</ListPlaceholder>
            ) : entries.length === 0 ? (
              <ListPlaceholder>No MCP servers configured for this project.</ListPlaceholder>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {entries.map((entry) => (
                  <McpServerListItem
                    key={entry.name}
                    entry={entry}
                    active={!creating && entry.name === selectedName}
                    onSelect={() => onSelect(entry.name)}
                  />
                ))}
              </ul>
            )}
          </nav>
        </aside>

        {/* ---- Editor ---- */}
        <section className="flex min-h-0 flex-col overflow-hidden">
          {creating || selectedEntry ? (
            <McpServerForm
              key={creating ? "__new__" : (selectedEntry?.name ?? "__none__")}
              projectId={projectId}
              draft={draft}
              mode={creating ? "create" : "edit"}
              readOnly={readOnly}
              onCreated={onCreated}
              onDeleted={onDeleted}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-fg-muted">
              Select a server to edit, or add a new one.
            </div>
          )}
        </section>
      </div>

      {showPresets && projectId && (
        <McpPresetPickerModal
          projectId={projectId}
          onClose={() => setShowPresets(false)}
          onApplied={(name) => {
            setShowPresets(false);
            setCreating(false);
            setSelectedName(name);
          }}
        />
      )}
    </div>
  );
}

function McpServerListItem({
  entry,
  active,
  onSelect,
}: {
  entry: DTO["MCPServerDTO"];
  active: boolean;
  onSelect: () => void;
}) {
  const transport = entry.transport ?? "stdio";
  const isStdio = transport === "stdio";
  const argsPreview = entry.args && entry.args.length > 0 ? entry.args.join(" ") : "";
  const subtitle = isStdio
    ? `${entry.command || "(no command)"}${argsPreview ? ` ${argsPreview}` : ""}`
    : entry.url || "(no url)";
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "group flex w-full flex-col gap-0.5 rounded-xl px-3 py-2 text-left transition-colors",
          active ? "bg-accent/10 text-accent" : "text-fg hover:bg-surface-alt",
        )}
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider",
              active ? "bg-accent/20 text-accent" : "bg-surface-alt text-fg-muted",
            )}
            title={`Transport: ${transport}`}
          >
            {transport}
          </span>
          {!entry.enabled && (
            <span
              className="rounded-full bg-surface-alt px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-fg-muted"
              title="Server is disabled"
            >
              off
            </span>
          )}
        </div>
        <div
          className={cn(
            "truncate font-mono text-[10px]",
            active ? "text-accent/80" : "text-fg-muted",
          )}
        >
          {subtitle}
        </div>
      </button>
    </li>
  );
}
