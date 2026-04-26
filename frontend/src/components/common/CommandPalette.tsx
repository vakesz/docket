import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Command } from "cmdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { DTO } from "~/api/client";
import {
  useIsPinned,
  useItem,
  useItems,
  useManualSync,
  usePin,
  usePinned,
  useProviders,
  useScopes,
  useSetActiveProvider,
  useSetActiveScope,
  useUnpin,
} from "~/api/hooks";
import { NewItemModal } from "~/components/items/NewItemModal";
import { cn } from "~/lib/cn";
import { formatKind } from "~/lib/format";
import { metaLabelClass, metaLabelFaintClass } from "~/lib/formClasses";
import { useEscapeKey } from "~/lib/hooks";
import { shortcut } from "~/lib/platform";

type Group = "Recent" | "Item" | "Navigate" | "Actions" | "Pinned" | "Items";

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

function extractItemId(pathname: string): string | undefined {
  const m = pathname.match(/^\/items\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => loadRecents());

  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const itemId = extractItemId(pathname);

  const items = useItems();
  const pinned = usePinned();
  const providers = useProviders();
  const scopes = useScopes();
  const item = useItem(itemId);
  const isPinned = useIsPinned(itemId);

  const sync = useManualSync();
  const pin = usePin();
  const unpin = useUnpin();
  const setActiveProvider = useSetActiveProvider();
  const setActiveScope = useSetActiveScope();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEscapeKey(useCallback(() => setOpen(false), []));

  const close = useCallback(() => setOpen(false), []);

  const go = useCallback(
    (to: string, params?: Record<string, string>) => {
      close();
      // biome-ignore lint/suspicious/noExplicitAny: router type requires a concrete key here but we branch at call sites.
      navigate({ to, params } as any);
    },
    [close, navigate],
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
        description: "Open the items list.",
        group: "Navigate",
        run: () => go("/items"),
      },
      {
        id: "nav-settings",
        label: "Settings",
        description: "Edit providers, prompts, MCP servers, and UI preferences.",
        group: "Navigate",
        keywords: "config preferences providers",
        run: () => go("/settings"),
      },
      {
        id: "nav-prompts",
        label: "Prompts",
        description: "Edit assistant prompt templates (lives under settings).",
        group: "Navigate",
        keywords: "templates assistant",
        run: () => go("/settings"),
      },
      {
        id: "nav-mcp",
        label: "MCP servers",
        description: "Configure Model Context Protocol servers (lives under settings).",
        group: "Navigate",
        keywords: "mcp tools",
        run: () => go("/settings"),
      },
      {
        id: "sync-now",
        label: "Sync now",
        description: "Pull the latest items from the active provider.",
        group: "Actions",
        keywords: "refresh pull",
        run: () => {
          sync.mutate({});
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
          sync.mutate({ full: true });
          close();
        },
      },
      {
        id: "new-item",
        label: "New work item",
        description: "Open the create-ticket form with duplicate check.",
        group: "Actions",
        keywords: "create ticket task story bug",
        run: () => {
          setOpen(false);
          setNewItemOpen(true);
        },
      },
    ];

    if (itemId) {
      const it = item.data;
      if (it?.url) {
        list.push({
          id: "open-in-browser",
          label: "Open in browser",
          description: "Open the current ticket in your browser.",
          group: "Item",
          keywords: it.id,
          run: () => {
            window.open(it.url ?? "", "_blank", "noopener,noreferrer");
            close();
          },
        });
      }
      const pinnedNow = isPinned.data?.pinned ?? false;
      list.push({
        id: pinnedNow ? "unpin-item" : "pin-item",
        label: pinnedNow ? "Unpin item" : "Pin item",
        description: pinnedNow
          ? "Remove this item from the pinned list."
          : "Pin this item so it survives scope and provider switches.",
        group: "Item",
        keywords: itemId,
        run: () => {
          if (pinnedNow) unpin.mutate(itemId);
          else pin.mutate(itemId);
          close();
        },
      });
    }

    const providerList = providers.data ?? [];
    const activeProviderKey = providerList.find((p) => p.active)?.key;
    for (const p of providerList) {
      if (p.key === activeProviderKey) continue;
      list.push({
        id: `switch-provider-${p.key}`,
        label: `Switch provider → ${p.display_name}`,
        description: `Activate the '${p.key}' provider.`,
        group: "Actions",
        keywords: p.key,
        run: () => {
          setActiveProvider.mutate(
            { key: p.key },
            { onSuccess: () => navigate({ to: "/items" }) },
          );
          close();
        },
      });
    }

    const scopeList = scopes.data ?? [];
    const activeScope = scopeList.find((s) => s.active)?.name;
    if (scopeList.length > 1) {
      for (const s of scopeList) {
        if (s.name === activeScope) continue;
        list.push({
          id: `switch-scope-${s.name}`,
          label: `Switch view → ${s.name}`,
          description: `Load the '${s.name}' saved view.`,
          group: "Actions",
          run: () => {
            setActiveScope.mutate({ name: s.name });
            close();
          },
        });
      }
    }

    return list;
  }, [
    close,
    go,
    item.data,
    isPinned.data?.pinned,
    itemId,
    navigate,
    pin,
    providers.data,
    scopes.data,
    setActiveProvider,
    setActiveScope,
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

  if (!open) {
    return newItemOpen ? (
      <NewItemModal
        defaultKind="task"
        onClose={() => setNewItemOpen(false)}
        onCreated={(id) => {
          setNewItemOpen(false);
          navigate({ to: "/items/$itemId", params: { itemId: id } });
        }}
      />
    ) : null;
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dismissive-overlay pattern — the interactive content is the child <Command> dialog; this div is only a backdrop that closes on click. Escape is handled globally.
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

          {pinned.data?.length ? (
            <Command.Group heading="Pinned" className={cn("px-2 py-1", metaLabelFaintClass)}>
              {pinned.data.map((it) => (
                <ItemEntry key={it.id} it={it} onSelect={() => go("/items/$itemId", { itemId: it.id })} />
              ))}
            </Command.Group>
          ) : null}

          {items.data?.length ? (
            <Command.Group heading="Items" className={cn("px-2 py-1", metaLabelFaintClass)}>
              {items.data.slice(0, 80).map((it) => (
                <ItemEntry key={it.id} it={it} onSelect={() => go("/items/$itemId", { itemId: it.id })} />
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

function PaletteEntry({
  command,
  onSelect,
}: {
  command: PaletteCommand;
  onSelect: () => void;
}) {
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

function ItemEntry({ it, onSelect }: { it: DTO["ItemDTO"]; onSelect: () => void }) {
  return (
    <Command.Item
      onSelect={onSelect}
      value={`${it.id} ${it.title}`}
      className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm data-[selected=true]:bg-surface-alt"
    >
      <span className={metaLabelClass}>{formatKind(it.kind)}</span>
      <span className="ml-2 truncate">{it.title}</span>
      <span className="ml-auto font-mono text-[10px] text-fg-faint">#{it.id}</span>
    </Command.Item>
  );
}
