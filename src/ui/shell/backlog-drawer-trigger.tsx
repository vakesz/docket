"use client";

import { Menu } from "lucide-react";
import { useSidebarDrawer } from "@/ui/shell/sidebar-drawer-context";

/**
 * Mobile-only hamburger that toggles whichever contextual sidebar the
 * current shell registered (items backlog or settings nav). Hidden on
 * `lg+` where the sidebar is already a permanent left pane, and hidden
 * whenever no shell with a sidebar is mounted (e.g. `/projects/new`).
 */
export function BacklogDrawerTrigger() {
  const { toggle, mounted } = useSidebarDrawer();
  if (!mounted) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Open menu"
      className="-ml-1 mr-1 rounded-md p-2 text-foreground hover:bg-muted lg:hidden"
    >
      <Menu className="h-5 w-5" />
    </button>
  );
}
