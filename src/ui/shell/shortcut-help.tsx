"use client";

import { useEffect, useState } from "react";
import { isMacLike } from "@/lib/platform";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/primitives/dialog";

type Shortcut = { keys: string[]; label: string };

const SHORTCUTS: Shortcut[] = [
  { keys: ["mod", "K"], label: "Open command palette" },
  { keys: ["?"], label: "Show keyboard shortcuts" },
  { keys: ["Esc"], label: "Close palette / dialogs" },
  { keys: ["↑", "↓"], label: "Move selection in palette" },
  { keys: ["Enter"], label: "Run selected command" },
];

/**
 * Discoverability layer for the keyboard surface. Press `?` anywhere outside
 * a text field to open the cheat sheet. The list is intentionally short:
 * only globally-bound keys live here, not per-pane shortcuts that change
 * with focus.
 */
export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  const [mac, setMac] = useState(false);

  useEffect(() => {
    setMac(isMacLike());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?") return;
      const target = e.target as HTMLElement | null;
      if (target && isEditableTarget(target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const modKey = mac ? "⌘" : "Ctrl";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="p-0 sm:max-w-[420px]">
        <DialogHeader className="border-border border-b px-4 py-3">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription className="sr-only">
            Globally-bound keys for the workspace.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col divide-y divide-border">
          {SHORTCUTS.map((s) => (
            <li key={s.label} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
              <span className="text-foreground">{s.label}</span>
              <span className="flex items-center gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={`${s.label}-${k}`}
                    className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {k === "mod" ? modKey : k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function isEditableTarget(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return false;
}
