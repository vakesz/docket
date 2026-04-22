import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { useEffect, useState } from "react";

import { useItems, useManualSync, usePinned } from "~/api/hooks";
import { formatKind } from "~/lib/format";
import { shortcut } from "~/lib/platform";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const items = useItems();
  const pinned = usePinned();
  const sync = useManualSync();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  const go = (to: string, params?: Record<string, string>) => {
    setOpen(false);
    // biome-ignore lint/suspicious/noExplicitAny: router type requires a concrete key here but we branch at call sites.
    navigate({ to, params } as any);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dismissive-overlay pattern — the interactive content is the child <Command> dialog; this div is only a backdrop that closes on click. Escape is handled globally.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <Command
        label="Command palette"
        className="w-[560px] max-w-[92vw] overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
      >
        <Command.Input
          placeholder="Jump to item, run command…"
          className="w-full border-b border-zinc-200 bg-transparent px-4 py-3 text-sm outline-none dark:border-zinc-800"
          autoFocus
        />
        <Command.List className="max-h-[56vh] overflow-auto p-1">
          <Command.Empty className="px-4 py-6 text-center text-sm text-zinc-500">
            No matches.
          </Command.Empty>

          <Command.Group
            heading="Navigate"
            className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-zinc-400"
          >
            <PaletteItem onSelect={() => go("/items")}>All items</PaletteItem>
            <PaletteItem onSelect={() => go("/pinned")}>Pinned</PaletteItem>
            <PaletteItem onSelect={() => go("/settings")}>Settings</PaletteItem>
            <PaletteItem onSelect={() => go("/settings")}>Prompts</PaletteItem>
          </Command.Group>

          <Command.Group
            heading="Actions"
            className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-zinc-400"
          >
            <PaletteItem
              onSelect={() => {
                sync.mutate();
                setOpen(false);
              }}
            >
              Sync now
            </PaletteItem>
          </Command.Group>

          {pinned.data?.length ? (
            <Command.Group
              heading="Pinned"
              className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-zinc-400"
            >
              {pinned.data.map((it) => (
                <PaletteItem key={it.id} onSelect={() => go("/items/$itemId", { itemId: it.id })}>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                    {formatKind(it.kind)}
                  </span>
                  <span className="ml-2 truncate">{it.title}</span>
                  <span className="ml-auto font-mono text-[10px] text-zinc-400">#{it.id}</span>
                </PaletteItem>
              ))}
            </Command.Group>
          ) : null}

          {items.data?.length ? (
            <Command.Group
              heading="Items"
              className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-zinc-400"
            >
              {items.data.slice(0, 80).map((it) => (
                <PaletteItem
                  key={it.id}
                  value={`${it.id} ${it.title}`}
                  onSelect={() => go("/items/$itemId", { itemId: it.id })}
                >
                  <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                    {formatKind(it.kind)}
                  </span>
                  <span className="ml-2 truncate">{it.title}</span>
                  <span className="ml-auto font-mono text-[10px] text-zinc-400">#{it.id}</span>
                </PaletteItem>
              ))}
            </Command.Group>
          ) : null}
        </Command.List>
        <div className="border-t border-zinc-200 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
          {shortcut("K")} · Esc to close
        </div>
      </Command>
    </div>
  );
}

function PaletteItem({
  children,
  onSelect,
  value,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  value?: string;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      value={value}
      className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm data-[selected=true]:bg-zinc-100 dark:data-[selected=true]:bg-zinc-900"
    >
      {children}
    </Command.Item>
  );
}
