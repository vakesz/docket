"use client";

import { LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/primitives/dropdown-menu";

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
   * Carried into the `/settings` link as `?project=<slug>` so the unified
   * settings page knows which project's per-project sections (memory,
   * sources, MCP) to populate. Null when the user is on a route without
   * an active project.
   */
  currentProjectSlug?: string | null;
};

/**
 * Top-right account button. Pops a small menu with a Settings link and a
 * Sign out form.
 */
export function AccountMenu({
  userLabel,
  userImage = null,
  signOutAction,
  currentProjectSlug = null,
}: Props) {
  const [imageBroken, setImageBroken] = useState(false);
  const initial = userLabel.trim().charAt(0).toUpperCase() || "?";
  const showImage = !!userImage && !imageBroken;
  const settingsHref = currentProjectSlug ? `/settings?project=${currentProjectSlug}` : "/settings";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-card text-xs font-semibold text-foreground leading-none",
          "hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        title={userLabel}
      >
        {showImage ? (
          // biome-ignore lint/performance/noImgElement: provider-agnostic remote avatar
          <img
            src={userImage}
            alt=""
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
            onError={() => setImageBroken(true)}
          />
        ) : (
          initial
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="text-xs uppercase tracking-wide text-muted-foreground/70">
            Signed in as
          </span>
          <span className="truncate text-sm text-foreground">{userLabel}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={settingsHref}>
            <Settings aria-hidden="true" className="text-muted-foreground" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <form action={signOutAction}>
          <DropdownMenuItem asChild>
            <button type="submit" className="flex w-full items-center gap-1.5 text-left">
              <LogOut aria-hidden="true" className="text-muted-foreground" />
              Sign out
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
