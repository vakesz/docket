"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type Props = {
  userLabel: string;
  signOutAction: () => Promise<void>;
};

/**
 * Top-right account button. Pops a small menu with a Settings link and a
 * Sign out form. Settings, theme, and sign-out used to live as separate
 * pills in the topbar; collapsing them under one affordance matches main
 * and frees the bar for the project switcher.
 */
export function AccountMenu({ userLabel, signOutAction }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current || ref.current.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initial = userLabel.trim().charAt(0).toUpperCase() || "?";

  return (
    <div ref={ref} className="relative inline-block shrink-0 leading-none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface text-xs font-semibold text-fg",
          "hover:bg-surface-alt focus:outline-none focus:ring-2 focus:ring-accent",
        )}
        title={userLabel}
      >
        {initial}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+0.375rem)] z-30 w-56 overflow-hidden rounded-md border border-border bg-surface shadow-lg"
        >
          <div className="border-b border-border px-3 py-2 text-xs text-fg-muted">
            <div className={metaCaps}>Signed in as</div>
            <div className="truncate text-sm text-fg">{userLabel}</div>
          </div>
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm text-fg hover:bg-surface-alt"
          >
            Settings
          </Link>
          <form action={signOutAction} className="border-t border-border">
            <button
              type="submit"
              role="menuitem"
              className="w-full px-3 py-2 text-left text-sm text-fg hover:bg-surface-alt"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

const metaCaps = "text-[10px] uppercase tracking-wide text-fg-faint";
