"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

interface SidebarDrawerController {
  open: boolean;
  setOpen: (next: boolean) => void;
  toggle: () => void;
  /**
   * True only when a shell with a contextual sidebar (items backlog,
   * settings nav, …) is mounted somewhere below this provider. The
   * trigger in the topbar reads this to hide itself on routes where
   * there's no sidebar to open.
   */
  mounted: boolean;
  registerMount: () => () => void;
}

const NO_OP: SidebarDrawerController = {
  open: false,
  setOpen: () => {},
  toggle: () => {},
  mounted: false,
  registerMount: () => () => {},
};

const Ctx = createContext<SidebarDrawerController | null>(null);

export function SidebarDrawerProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpenState] = useState(false);
  const [mountCount, setMountCount] = useState(0);
  const setOpen = useCallback((next: boolean) => setOpenState(next), []);
  const toggle = useCallback(() => setOpenState((v) => !v), []);
  const registerMount = useCallback(() => {
    setMountCount((n) => n + 1);
    return () => setMountCount((n) => Math.max(0, n - 1));
  }, []);
  return (
    <Ctx.Provider value={{ open, setOpen, toggle, mounted: mountCount > 0, registerMount }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSidebarDrawer(): SidebarDrawerController {
  return useContext(Ctx) ?? NO_OP;
}

/**
 * Call from a component that owns a contextual sidebar (items shell,
 * settings shell). Bumps the provider's mount counter on mount,
 * decrements on unmount, so the topbar trigger knows whether there's
 * anything to toggle.
 */
export function useRegisterSidebarMount() {
  const { registerMount } = useSidebarDrawer();
  useEffect(() => registerMount(), [registerMount]);
}
