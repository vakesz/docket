"use client";

import type { ReactNode } from "react";
import { SidebarDrawerProvider } from "@/ui/shell/sidebar-drawer-context";

/**
 * Hosts client-side context providers that span the topbar AND the
 * shell beneath it — the sidebar drawer is opened from a button in the
 * topbar but its state is consumed by whichever shell registered the
 * contextual sidebar (items backlog, settings nav).
 */
export function WorkspaceProviders({ children }: { children: ReactNode }) {
  return <SidebarDrawerProvider>{children}</SidebarDrawerProvider>;
}
