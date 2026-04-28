"use client";

import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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
 * Sign out form.
 */
export function AccountMenu({
  userLabel,
  userImage = null,
  signOutAction,
  currentProjectId = null,
}: Props) {
  const [imageBroken, setImageBroken] = useState(false);
  const initial = userLabel.trim().charAt(0).toUpperCase() || "?";
  const showImage = !!userImage && !imageBroken;

  return (
    <Menu as="div" className="relative inline-block shrink-0 leading-none">
      <MenuButton
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-border bg-surface text-xs font-semibold text-fg",
          "hover:bg-surface-alt focus:outline-none focus:ring-2 focus:ring-accent",
        )}
        title={userLabel}
      >
        {showImage ? (
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
      </MenuButton>
      <MenuItems
        anchor="bottom end"
        transition
        className={cn(
          "z-30 w-56 origin-top-right overflow-hidden rounded-xl border border-border bg-surface shadow-lg [--anchor-gap:0.5rem] focus:outline-none",
          "transition data-closed:scale-95 data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in",
        )}
      >
        <div className="border-b border-border px-3 py-2 text-xs text-fg-muted">
          <div className={metaLabelFaintClass}>Signed in as</div>
          <div className="truncate text-sm text-fg">{userLabel}</div>
        </div>
        <MenuItem>
          <Link
            href={currentProjectId ? `/settings?project=${currentProjectId}` : "/settings"}
            className="flex items-center gap-2 px-3 py-2 text-sm text-fg data-focus:bg-surface-alt"
          >
            <Settings aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" />
            Settings
          </Link>
        </MenuItem>
        <form action={signOutAction} className="border-t border-border">
          <MenuItem>
            <button
              type="submit"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg data-focus:bg-surface-alt"
            >
              <LogOut aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" />
              Sign out
            </button>
          </MenuItem>
        </form>
      </MenuItems>
    </Menu>
  );
}
