"use client";

import { LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { metaLabelFaintClass } from "@/lib/form-classes";
import { cn } from "@/lib/utils";

type Props = {
  userLabel: string;
  /**
   * Avatar URL from the OAuth provider's user record (NextAuth's
   * `User.image`). Provider-agnostic: any provider that returns an image
   * via NextAuth's profile callback ends up here. Null means we render the
   * fallback initial — same shape as before image support existed.
   */
  userImage?: string | null;
  signOutAction: () => Promise<void>;
  /**
   * Carried into the `/settings` link as `?project=<id>` so the unified
   * settings page knows which project's per-project sections (memory,
   * sources, MCP) to populate. Null when the user is on a route without
   * an active project.
   */
  currentProjectId?: string | null;
};

/**
 * Top-right account button. Pops a small menu with a Settings link and a
 * Sign out form. Settings, theme, and sign-out used to live as separate
 * pills in the topbar; collapsing them under one affordance matches main
 * and frees the bar for the project switcher.
 */
export function AccountMenu({
  userLabel,
  userImage = null,
  signOutAction,
  currentProjectId = null,
}: Props) {
  const [open, setOpen] = useState(false);
  const [imageBroken, setImageBroken] = useState(false);
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
  const showImage = !!userImage && !imageBroken;

  return (
    <div ref={ref} className="relative inline-block shrink-0 leading-none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-border bg-surface text-xs font-semibold text-fg",
          "hover:bg-surface-alt focus:outline-none focus:ring-2 focus:ring-accent",
        )}
        title={userLabel}
      >
        {showImage ? (
          // Plain <img> rather than next/image: avatar URLs are provider-
          // dependent (GitHub, Microsoft Graph, etc.) and Next's optimizer
          // requires every host be allowlisted in next.config — that would
          // tie this component to a fixed provider list.
          // biome-ignore lint/performance/noImgElement: provider-agnostic remote avatar
          <img
            src={userImage as string}
            alt=""
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
            onError={() => setImageBroken(true)}
          />
        ) : (
          initial
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+0.375rem)] z-30 w-56 overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
        >
          <div className="border-b border-border px-3 py-2 text-xs text-fg-muted">
            <div className={metaLabelFaintClass}>Signed in as</div>
            <div className="truncate text-sm text-fg">{userLabel}</div>
          </div>
          <Link
            href={currentProjectId ? `/settings?project=${currentProjectId}` : "/settings"}
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-sm text-fg hover:bg-surface-alt"
          >
            <Settings aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" />
            Settings
          </Link>
          <form action={signOutAction} className="border-t border-border">
            <button
              type="submit"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg hover:bg-surface-alt"
            >
              <LogOut aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" />
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
