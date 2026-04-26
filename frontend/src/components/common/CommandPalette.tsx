import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { useCallback, useEffect, useState } from "react";

import { useItems, useManualSync, usePinned } from "~/api/hooks";
import { cn } from "~/lib/cn";
import { formatKind } from "~/lib/format";
import { metaLabelClass, metaLabelFaintClass } from "~/lib/formClasses";
import { useEscapeKey } from "~/lib/hooks";
import { shortcut } from "~/lib/platform";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const items = useItems();
  const pinned = usePinned();
  const sync = useManualSync();

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

  if (!open) return null;

  const go = (to: string, params?: Record<string, string>) => {
    setOpen(false);
    // biome-ignore lint/suspicious/noExplicitAny: router type requires a concrete key here but we branch at call sites.
    navigate({ to, params } as any);
  };

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

          <Command.Group heading="Navigate" className={cn("px-2 py-1", metaLabelFaintClass)}>
            <PaletteItem onSelect={() => go("/items")}>All items</PaletteItem>
            <PaletteItem onSelect={() => go("/settings")}>Settings</PaletteItem>
            <PaletteItem onSelect={() => go("/settings")}>Prompts</PaletteItem>
          </Command.Group>

          <Command.Group heading="Actions" className={cn("px-2 py-1", metaLabelFaintClass)}>
            <PaletteItem
              onSelect={() => {
                sync.mutate({});
                setOpen(false);
              }}
            >
              Sync now
            </PaletteItem>
          </Command.Group>

          {pinned.data?.length ? (
            <Command.Group heading="Pinned" className={cn("px-2 py-1", metaLabelFaintClass)}>
              {pinned.data.map((it) => (
                <PaletteItem key={it.id} onSelect={() => go("/items/$itemId", { itemId: it.id })}>
                  <span className={metaLabelClass}>{formatKind(it.kind)}</span>
                  <span className="ml-2 truncate">{it.title}</span>
                  <span className="ml-auto font-mono text-[10px] text-fg-faint">#{it.id}</span>
                </PaletteItem>
              ))}
            </Command.Group>
          ) : null}

          {items.data?.length ? (
            <Command.Group heading="Items" className={cn("px-2 py-1", metaLabelFaintClass)}>
              {items.data.slice(0, 80).map((it) => (
                <PaletteItem
                  key={it.id}
                  value={`${it.id} ${it.title}`}
                  onSelect={() => go("/items/$itemId", { itemId: it.id })}
                >
                  <span className={metaLabelClass}>{formatKind(it.kind)}</span>
                  <span className="ml-2 truncate">{it.title}</span>
                  <span className="ml-auto font-mono text-[10px] text-fg-faint">#{it.id}</span>
                </PaletteItem>
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
      className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm data-[selected=true]:bg-surface-alt"
    >
      {children}
    </Command.Item>
  );
}
