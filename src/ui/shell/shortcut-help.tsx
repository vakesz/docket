"use client";

import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useEffect, useState } from "react";
import { metaLabelFaintClass } from "@/lib/form-classes";
import { isMacLike } from "@/lib/platform";
import { cn } from "@/lib/utils";

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
    <Dialog open={open} onClose={() => setOpen(false)} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-fg/40" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-[420px] max-w-full overflow-hidden rounded-lg border border-border bg-surface text-fg shadow-2xl">
          <div
            className={cn(
              "flex items-center justify-between border-b border-border px-4 py-2",
              metaLabelFaintClass,
            )}
          >
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded px-1 text-fg-muted hover:bg-surface-alt hover:text-fg"
              aria-label="Close shortcuts"
            >
              Esc
            </button>
          </div>
          <ul className="flex flex-col divide-y divide-border">
            {SHORTCUTS.map((s) => (
              <li
                key={s.label}
                className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
              >
                <span className="text-fg">{s.label}</span>
                <span className="flex items-center gap-1">
                  {s.keys.map((k, i) => (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: stable list rendered once.
                      key={`${s.label}-${i}`}
                      className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-muted"
                    >
                      {k === "mod" ? modKey : k}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

function isEditableTarget(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return false;
}
