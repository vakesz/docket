"use client";

import { Command } from "cmdk";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { metaLabelClass, metaLabelFaintClass } from "@/lib/form-classes";
import { formatKind } from "@/lib/format";
import { shortcut } from "@/lib/platform";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";

type Group = "Recent" | "Item" | "Navigate" | "Actions" | "Pinned" | "Items";

type ProjectOption = { id: string; name: string };

type ItemSummary = {
  id: string;
  providerItemId: string;
  kind: string;
  title: string;
  state: string;
  url: string | null;
};

interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  hint?: string;
  group: Group;
  keywords?: string;
  run: () => void;
}

const RECENTS_KEY = "docket.cmdPaletteRecents";
const RECENTS_LIMIT = 5;

function loadRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveRecents(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(ids.slice(0, RECENTS_LIMIT)));
  } catch {
    // localStorage may be disabled (private mode, quota); silently degrade.
  }
}

function pushRecent(prev: string[], id: string): string[] {
  return [id, ...prev.filter((x) => x !== id)].slice(0, RECENTS_LIMIT);
}

function extractItemId(pathname: string | null, projectId: string): string | undefined {
  if (!pathname) return undefined;
  const prefix = `/projects/${projectId}/items/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const tail = pathname.slice(prefix.length).split("/")[0]?.trim();
  return tail || undefined;
}

/**
 * Global cmdk palette mounted by the project shell. Cmd/Ctrl+K toggles it,
 * Esc closes it, and the dismissive backdrop click also closes it. Recents
 * are kept in localStorage so commands the user actually uses float to the
 * top across reloads.
 *
 * T3 is per-project, not global-active-provider like main was, so commands
 * scope to the current `projectId` and navigation goes through the Next
 * App Router. Item / pin commands are surfaced when the current URL has
 * an itemId — no need for the user to click first.
 */
export function CommandPalette({
  projectId,
  projects,
}: {
  projectId: string;
  projects: ProjectOption[];
}) {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => loadRecents());

  const router = useRouter();
  const pathname = usePathname();
  const itemId = extractItemId(pathname, projectId);

  const utils = trpc.useUtils();

  const items = trpc.items.list.useQuery({ projectId, limit: 100 }, { enabled: open });
  const pinned = trpc.watchlist.list.useQuery({ projectId, limit: 50 }, { enabled: open });
  const pendingProposals = trpc.proposals.list.useQuery(
    { projectId, status: "pending", limit: 100 },
    { enabled: open },
  );
  const isPinned = trpc.watchlist.isPinned.useQuery(
    { projectId, providerItemId: itemId ?? "" },
    { enabled: open && Boolean(itemId) },
  );
  const currentItem = trpc.items.get.useQuery(
    { projectId, itemId: itemId ?? "" },
    { enabled: open && Boolean(itemId) },
  );

  const sync = trpc.items.runSync.useMutation({
    onSuccess: async () => {
      await utils.items.list.invalidate();
      router.refresh();
    },
  });
  const pin = trpc.watchlist.pin.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.watchlist.isPinned.invalidate(), utils.watchlist.list.invalidate()]);
    },
  });
  const unpin = trpc.watchlist.unpin.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.watchlist.isPinned.invalidate(), utils.watchlist.list.invalidate()]);
    },
  });
  const rejectProposal = trpc.proposals.reject.useMutation({
    onSuccess: async () => {
      await utils.proposals.list.invalidate({ projectId });
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const go = useCallback(
    (to: string) => {
      close();
      router.push(to);
    },
    [close, router],
  );

  const record = useCallback((id: string) => {
    setRecents((prev) => {
      const next = pushRecent(prev, id);
      saveRecents(next);
      return next;
    });
  }, []);

  const runWith = useCallback(
    (cmd: PaletteCommand) => () => {
      record(cmd.id);
      cmd.run();
    },
    [record],
  );

  const commands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [
      {
        id: "nav-items",
        label: "All items",
        description: "Open the items list for this project.",
        group: "Navigate",
        run: () => go(`/projects/${projectId}/items`),
      },
      {
        id: "nav-settings",
        label: "Settings",
        description:
          "Per-user preferences (default project, send-on-enter) plus deployment-wide LLM and OAuth provider config.",
        group: "Navigate",
        keywords:
          "config preferences default project profile llm oauth openai anthropic github azure devops",
        run: () => go("/settings"),
      },
      {
        id: "sync-now",
        label: "Sync now",
        description: "Pull the latest items from the project's provider (incremental).",
        group: "Actions",
        keywords: "refresh pull",
        run: () => {
          sync.mutate({ projectId, mode: "incremental" });
          close();
        },
      },
      {
        id: "full-sync",
        label: "Full sync",
        description: "Reset the watermark and re-pull everything the provider exposes.",
        group: "Actions",
        keywords: "refresh reset rebuild",
        run: () => {
          sync.mutate({ projectId, mode: "full" });
          close();
        },
      },
    ];

    const pendingCount = pendingProposals.data?.length ?? 0;
    if (pendingCount > 0) {
      list.push({
        id: "dismiss-all-pending",
        label: `Dismiss all pending proposals (${pendingCount})`,
        description:
          "Reject every staged proposal in this project — useful when an agent run errored mid-turn and left orphans behind.",
        group: "Actions",
        keywords: "reject clear pending proposals orphan",
        run: () => {
          const ids = pendingProposals.data?.map((p) => p.id) ?? [];
          for (const id of ids) {
            rejectProposal.mutate({ projectId, proposalId: id });
          }
          close();
        },
      });
    }

    if (itemId) {
      const it = currentItem.data;
      if (it?.url) {
        list.push({
          id: "open-in-browser",
          label: "Open in browser",
          description: "Open the current ticket in your browser.",
          group: "Item",
          keywords: it.providerItemId,
          run: () => {
            window.open(it.url ?? "", "_blank", "noopener,noreferrer");
            close();
          },
        });
      }
      if (it?.providerItemId) {
        const pinnedNow = isPinned.data?.pinned ?? false;
        list.push({
          id: pinnedNow ? "unpin-item" : "pin-item",
          label: pinnedNow ? "Unpin item" : "Pin item",
          description: pinnedNow
            ? "Remove this item from the pinned list."
            : "Pin this item so it survives view and sync changes.",
          group: "Item",
          keywords: it.providerItemId,
          run: () => {
            if (pinnedNow) unpin.mutate({ projectId, providerItemId: it.providerItemId });
            else pin.mutate({ projectId, providerItemId: it.providerItemId });
            close();
          },
        });
      }
    }

    for (const p of projects) {
      if (p.id === projectId) continue;
      list.push({
        id: `switch-project-${p.id}`,
        label: `Switch project → ${p.name}`,
        description: `Open the '${p.name}' project's items.`,
        group: "Actions",
        keywords: p.name,
        run: () => go(`/projects/${p.id}/items`),
      });
    }

    return list;
  }, [
    close,
    currentItem.data,
    go,
    isPinned.data?.pinned,
    itemId,
    pendingProposals.data,
    pin,
    projectId,
    projects,
    rejectProposal,
    sync,
    unpin,
  ]);

  const byId = useMemo(() => {
    const map = new Map<string, PaletteCommand>();
    for (const c of commands) map.set(c.id, c);
    return map;
  }, [commands]);

  const recentCommands = useMemo(
    () => recents.map((id) => byId.get(id)).filter((c): c is PaletteCommand => Boolean(c)),
    [byId, recents],
  );

  const recentIds = useMemo(() => new Set(recentCommands.map((c) => c.id)), [recentCommands]);

  const grouped = useMemo(() => {
    const groups: Record<Exclude<Group, "Recent">, PaletteCommand[]> = {
      Item: [],
      Navigate: [],
      Actions: [],
      Pinned: [],
      Items: [],
    };
    for (const c of commands) {
      if (recentIds.has(c.id)) continue;
      if (c.group === "Recent") continue;
      groups[c.group].push(c);
    }
    return groups;
  }, [commands, recentIds]);

  if (!open) return null;

  const pinnedItems: ItemSummary[] = (pinned.data ?? []).map((row) => ({
    id: row.item.id,
    providerItemId: row.item.providerItemId,
    kind: row.item.kind,
    title: row.item.title,
    state: row.item.state,
    url: row.item.url,
  }));

  const itemList: ItemSummary[] = (items.data ?? []).map((row) => ({
    id: row.id,
    providerItemId: row.providerItemId,
    kind: row.kind,
    title: row.title,
    state: row.state,
    url: row.url,
  }));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dismissive-overlay pattern — interactive content is the child <Command> dialog; this div is only a backdrop that closes on click. Escape is handled globally above.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-fg/40 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <Command
        label="Command palette"
        className="w-[560px] max-w-[92vw] overflow-hidden rounded-lg border border-border bg-surface text-fg shadow-2xl"
      >
        <Command.Input
          placeholder="Jump to item, run command…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-fg outline-none"
          autoFocus
          // Keep password managers (Bitwarden, 1Password, etc.) from
          // mistaking the palette's search input for a credential field.
          // The non-standard data-* hints cover the password managers that
          // ignore autoComplete="off".
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          name="docket-command-palette-search"
          enterKeyHint="search"
          data-form-type="other"
          data-lpignore="true"
          data-1p-ignore="true"
          data-bwignore="true"
        />
        <Command.List className="max-h-[56vh] overflow-auto p-1">
          <Command.Empty className="px-4 py-6 text-center text-sm text-fg-faint">
            No matches.
          </Command.Empty>

          {recentCommands.length > 0 ? (
            <Command.Group heading="Recent" className={cn("px-2 py-1", metaLabelFaintClass)}>
              {recentCommands.map((c) => (
                <PaletteEntry key={c.id} command={c} onSelect={runWith(c)} />
              ))}
            </Command.Group>
          ) : null}

          {grouped.Item.length > 0 ? (
            <Command.Group heading="Item" className={cn("px-2 py-1", metaLabelFaintClass)}>
              {grouped.Item.map((c) => (
                <PaletteEntry key={c.id} command={c} onSelect={runWith(c)} />
              ))}
            </Command.Group>
          ) : null}

          {grouped.Navigate.length > 0 ? (
            <Command.Group heading="Navigate" className={cn("px-2 py-1", metaLabelFaintClass)}>
              {grouped.Navigate.map((c) => (
                <PaletteEntry key={c.id} command={c} onSelect={runWith(c)} />
              ))}
            </Command.Group>
          ) : null}

          {grouped.Actions.length > 0 ? (
            <Command.Group heading="Actions" className={cn("px-2 py-1", metaLabelFaintClass)}>
              {grouped.Actions.map((c) => (
                <PaletteEntry key={c.id} command={c} onSelect={runWith(c)} />
              ))}
            </Command.Group>
          ) : null}

          {pinnedItems.length > 0 ? (
            <Command.Group heading="Pinned" className={cn("px-2 py-1", metaLabelFaintClass)}>
              {pinnedItems.map((it) => (
                <ItemEntry
                  key={it.id}
                  item={it}
                  onSelect={() => go(`/projects/${projectId}/items/${it.id}`)}
                />
              ))}
            </Command.Group>
          ) : null}

          {itemList.length > 0 ? (
            <Command.Group heading="Items" className={cn("px-2 py-1", metaLabelFaintClass)}>
              {itemList.slice(0, 80).map((it) => (
                <ItemEntry
                  key={it.id}
                  item={it}
                  onSelect={() => go(`/projects/${projectId}/items/${it.id}`)}
                />
              ))}
            </Command.Group>
          ) : null}
        </Command.List>
        <div className={cn("border-t border-border px-3 py-2", metaLabelFaintClass)}>
          {shortcut("K")} · Esc to close
        </div>
      </Command>
    </div>
  );
}

function PaletteEntry({ command, onSelect }: { command: PaletteCommand; onSelect: () => void }) {
  const value = [command.label, command.description ?? "", command.keywords ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <Command.Item
      onSelect={onSelect}
      value={value}
      className="flex cursor-pointer items-center gap-3 rounded px-3 py-2 text-sm data-[selected=true]:bg-surface-alt"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-fg">{command.label}</span>
        {command.description ? (
          <span className="truncate text-xs text-fg-faint">{command.description}</span>
        ) : null}
      </span>
      {command.hint ? (
        <span className="ml-auto rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
          {command.hint}
        </span>
      ) : null}
    </Command.Item>
  );
}

function ItemEntry({ item, onSelect }: { item: ItemSummary; onSelect: () => void }) {
  return (
    <Command.Item
      onSelect={onSelect}
      value={`${item.providerItemId} ${item.title}`}
      className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm data-[selected=true]:bg-surface-alt"
    >
      <span className={metaLabelClass}>{formatKind(item.kind)}</span>
      <span className="ml-2 truncate">{item.title}</span>
      <span className="ml-auto font-mono text-[10px] text-fg-faint">#{item.providerItemId}</span>
    </Command.Item>
  );
}
