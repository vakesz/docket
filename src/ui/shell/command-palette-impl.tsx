"use client";

import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import type { ItemKind, ItemState } from "@/core/types";
import { formatKind } from "@/lib/format";
import { shortcut } from "@/lib/platform";
import { trpc } from "@/lib/trpc-client";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/ui/primitives/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/primitives/dialog";

type ProjectOption = { id: string; slug: string; name: string };

type ItemSummary = {
  id: string;
  providerItemId: string;
  itemNumber: string;
  kind: ItemKind;
  title: string;
  state: ItemState;
  url: string | null;
};

interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  hint?: string;
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

function extractItemNumber(pathname: string | null, projectSlug: string): string | undefined {
  if (!pathname) return undefined;
  const prefix = `/projects/${projectSlug}/items/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const tail = pathname.slice(prefix.length).split("/")[0]?.trim();
  return tail || undefined;
}

/**
 * cmdk-backed palette body. Open state and the global Cmd/Ctrl+K listener
 * live in the parent shell (`command-palette.tsx`) so this file — along
 * with cmdk and radix Dialog — only loads after the user opens the
 * palette for the first time. Recents are kept in localStorage so
 * commands the user actually uses float to the top across reloads.
 */
export function CommandPaletteImpl({
  projectSlug,
  projects,
  open,
  onOpenChange,
}: {
  projectSlug: string;
  projects: ProjectOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setOpen = onOpenChange;
  const [recents, setRecents] = useState<string[]>(() => loadRecents());

  const router = useRouter();
  const pathname = usePathname();
  const itemNumber = extractItemNumber(pathname, projectSlug);

  const utils = trpc.useUtils();

  const items = trpc.items.list.useQuery({ projectSlug, limit: 100 }, { enabled: open });
  const pinned = trpc.watchlist.list.useQuery({ projectSlug, limit: 50 }, { enabled: open });
  const pendingProposals = trpc.proposals.list.useQuery(
    { projectSlug, status: "pending", limit: 100 },
    { enabled: open },
  );
  const currentItem = trpc.items.get.useQuery(
    { projectSlug, itemNumber: itemNumber ?? "" },
    { enabled: open && Boolean(itemNumber) },
  );
  const isPinned = trpc.watchlist.isPinned.useQuery(
    { projectSlug, providerItemId: currentItem.data?.providerItemId ?? "" },
    { enabled: open && Boolean(currentItem.data?.providerItemId) },
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
      await utils.proposals.list.invalidate({ projectSlug });
    },
  });

  const go = (to: string) => {
    setOpen(false);
    router.push(to as Route);
  };

  const record = (id: string) => {
    setRecents((prev) => {
      const next = pushRecent(prev, id);
      saveRecents(next);
      return next;
    });
  };

  const itemCommands: PaletteCommand[] = (() => {
    const list: PaletteCommand[] = [];
    if (!itemNumber) return list;
    const it = currentItem.data;
    if (it?.url) {
      list.push({
        id: "open-in-browser",
        label: "Open in browser",
        description: "Open the current ticket in your browser.",
        keywords: it.providerItemId,
        run: () => {
          window.open(it.url ?? "", "_blank", "noopener,noreferrer");
          setOpen(false);
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
        keywords: it.providerItemId,
        run: () => {
          if (pinnedNow) unpin.mutate({ projectSlug, providerItemId: it.providerItemId });
          else pin.mutate({ projectSlug, providerItemId: it.providerItemId });
          setOpen(false);
        },
      });
    }
    return list;
  })();

  const navigateCommands: PaletteCommand[] = [
    {
      id: "nav-items",
      label: "All items",
      description: "Open the items list for this project.",
      run: () => go(`/projects/${projectSlug}/items`),
    },
    {
      id: "nav-settings",
      label: "Settings",
      description:
        "Per-user preferences (default project, send-on-enter) plus deployment-wide LLM and OAuth provider config.",
      keywords:
        "config preferences default project profile llm oauth openai anthropic github azure devops",
      run: () => go("/settings"),
    },
  ];

  const actionCommands: PaletteCommand[] = (() => {
    const list: PaletteCommand[] = [
      {
        id: "sync-now",
        label: "Sync now",
        description: "Pull the latest items from the project's provider (incremental).",
        keywords: "refresh pull",
        run: () => {
          sync.mutate({ projectSlug, mode: "incremental" });
          setOpen(false);
        },
      },
      {
        id: "full-sync",
        label: "Full sync",
        description: "Reset the watermark and re-pull everything the provider exposes.",
        keywords: "refresh reset rebuild",
        run: () => {
          sync.mutate({ projectSlug, mode: "full" });
          setOpen(false);
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
        keywords: "reject clear pending proposals orphan",
        run: () => {
          const ids = pendingProposals.data?.map((p) => p.id) ?? [];
          for (const id of ids) {
            rejectProposal.mutate({ projectSlug, proposalId: id });
          }
          setOpen(false);
        },
      });
    }

    for (const p of projects) {
      if (p.slug === projectSlug) continue;
      list.push({
        id: `switch-project-${p.id}`,
        label: `Switch project → ${p.name}`,
        description: `Open the '${p.name}' project's items.`,
        keywords: p.name,
        run: () => go(`/projects/${p.slug}/items`),
      });
    }

    return list;
  })();

  const allCommands = [...itemCommands, ...navigateCommands, ...actionCommands];

  const byId = new Map<string, PaletteCommand>();
  for (const c of allCommands) byId.set(c.id, c);

  const recentCommands = recents
    .map((id) => byId.get(id))
    .filter((c): c is PaletteCommand => Boolean(c));
  const recentIds = new Set(recentCommands.map((c) => c.id));

  const pinnedItems: ItemSummary[] = (pinned.data ?? []).map((row) => ({
    id: row.item.id,
    providerItemId: row.item.providerItemId,
    itemNumber: row.item.itemNumber,
    kind: row.item.kind,
    title: row.item.title,
    state: row.item.state,
    url: row.item.url,
  }));

  const itemList: ItemSummary[] = (items.data ?? []).slice(0, 80).map((row) => ({
    id: row.id,
    providerItemId: row.providerItemId,
    itemNumber: row.itemNumber,
    kind: row.kind,
    title: row.title,
    state: row.state,
    url: row.url,
  }));

  const runCommand = (c: PaletteCommand) => {
    record(c.id);
    c.run();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[560px]"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>Jump to an item or run a command.</DialogDescription>
        </DialogHeader>
        <Command className="rounded-none">
          <CommandInput
            placeholder="Jump to item, run command…"
            autoFocus
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
          <CommandList className="max-h-[56vh]">
            <CommandEmpty>No matches.</CommandEmpty>

            {recentCommands.length > 0 ? (
              <CommandGroup heading="Recent">
                {recentCommands.map((c) => (
                  <CommandRow key={`recent-${c.id}`} command={c} onSelect={() => runCommand(c)} />
                ))}
              </CommandGroup>
            ) : null}

            {itemCommands.length > 0 ? (
              <CommandGroup heading="Item">
                {itemCommands
                  .filter((c) => !recentIds.has(c.id))
                  .map((c) => (
                    <CommandRow key={c.id} command={c} onSelect={() => runCommand(c)} />
                  ))}
              </CommandGroup>
            ) : null}

            <CommandGroup heading="Navigate">
              {navigateCommands
                .filter((c) => !recentIds.has(c.id))
                .map((c) => (
                  <CommandRow key={c.id} command={c} onSelect={() => runCommand(c)} />
                ))}
            </CommandGroup>

            <CommandGroup heading="Actions">
              {actionCommands
                .filter((c) => !recentIds.has(c.id))
                .map((c) => (
                  <CommandRow key={c.id} command={c} onSelect={() => runCommand(c)} />
                ))}
            </CommandGroup>

            {pinnedItems.length > 0 ? (
              <CommandGroup heading="Pinned">
                {pinnedItems.map((it) => (
                  <ItemRow
                    key={`pinned-${it.id}`}
                    item={it}
                    onSelect={() => go(`/projects/${projectSlug}/items/${it.itemNumber}`)}
                  />
                ))}
              </CommandGroup>
            ) : null}

            {itemList.length > 0 ? (
              <CommandGroup heading="Items">
                {itemList.map((it) => (
                  <ItemRow
                    key={it.id}
                    item={it}
                    onSelect={() => go(`/projects/${projectSlug}/items/${it.itemNumber}`)}
                  />
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
          <CommandSeparator />
          <div className="px-3 py-2 text-muted-foreground/70 text-xs uppercase tracking-wide">
            {shortcut("K")} · Esc to close
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandRow({ command, onSelect }: { command: PaletteCommand; onSelect: () => void }) {
  const value = [command.id, command.label, command.description ?? "", command.keywords ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <CommandItem value={value} onSelect={onSelect}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-foreground">{command.label}</span>
        {command.description ? (
          <span className="truncate text-muted-foreground/70 text-xs">{command.description}</span>
        ) : null}
      </span>
      {command.hint ? (
        <kbd className="ml-auto rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {command.hint}
        </kbd>
      ) : null}
    </CommandItem>
  );
}

function ItemRow({ item, onSelect }: { item: ItemSummary; onSelect: () => void }) {
  return (
    <CommandItem value={`${item.providerItemId} ${item.title}`} onSelect={onSelect}>
      <span className="text-muted-foreground text-xs uppercase tracking-wide">
        {formatKind(item.kind)}
      </span>
      <span className="ml-2 truncate">{item.title}</span>
      <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
        #{item.itemNumber}
      </span>
    </CommandItem>
  );
}
