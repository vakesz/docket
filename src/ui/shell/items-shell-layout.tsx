"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useChatPaneController } from "@/ui/conversations/chat-pane-context";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/ui/primitives/sheet";
import { useRegisterSidebarMount, useSidebarDrawer } from "@/ui/shell/sidebar-drawer-context";

const RESIZE_HANDLE_CLASS =
  "w-px bg-border transition-colors data-[resize-handle-state=hover]:bg-muted-foreground-faint data-[resize-handle-state=drag]:bg-primary";

/**
 * The 3-pane workspace.
 *
 * `lg+`: backlog (left), detail (middle), chat (right) inside a
 * `react-resizable-panels` Group. If `right` is null, the chat pane
 * collapses entirely and the middle pane expands.
 *
 * `<lg`: the middle pane is the only always-visible pane. The backlog
 * slides in as a left drawer (toggled from the topbar hamburger), and
 * chat takes over as a near-full-width right drawer (toggled from the
 * item detail header). Both drawers are mutually exclusive — opening one
 * closes the other — and dismiss on item navigation so the user lands
 * back in the detail.
 *
 * Persistence note: defaults stay deterministic. A previous attempt to
 * persist sizes to localStorage outlived layout-shape changes and produced
 * nonsensical widths after any resize.
 */
export function ItemsShellLayout({
  left,
  middle,
  right,
  groupId = "docket.shell",
}: {
  left: React.ReactNode;
  middle: React.ReactNode;
  right: React.ReactNode | null;
  groupId?: string;
}) {
  useRegisterSidebarMount();
  const showRight = right !== null;
  const backlog = useSidebarDrawer();
  const chat = useChatPaneController();
  const { open: backlogOpen, setOpen: setBacklogOpen } = backlog;
  const { open: chatOpen, setOpen: setChatOpen } = chat;
  const pathname = usePathname();
  const isBelowLg = useIsBelowLg();

  useEffect(() => {
    if (pathname) setBacklogOpen(false);
  }, [pathname, setBacklogOpen]);

  useEffect(() => {
    if (backlogOpen && chatOpen) setChatOpen(false);
  }, [backlogOpen, chatOpen, setChatOpen]);

  // Sheet (radix Dialog) only mounts its portal children while open. We
  // still gate the controlled `open` prop on viewport so the same drawer
  // doesn't try to render `left` / `right` while they're already mounted
  // in the desktop Group above. `null` (pre-hydration) is treated as "not
  // below lg" so SSR markup matches the desktop default.
  const showMobileBacklog = isBelowLg === true && backlogOpen;
  const showMobileChat = isBelowLg === true && chatOpen;

  return (
    <>
      <div className="hidden flex-1 overflow-hidden lg:flex">
        <Group
          orientation="horizontal"
          id={`${groupId}.${showRight ? "3pane" : "2pane"}`}
          className="group flex-1 overflow-hidden"
        >
          <Panel
            id="left"
            defaultSize={showRight ? 22 : 28}
            minSize={14}
            className="overflow-hidden"
          >
            {left}
          </Panel>
          <Separator className={RESIZE_HANDLE_CLASS} />
          <Panel
            id="middle"
            defaultSize={showRight ? 48 : 72}
            minSize={30}
            className="overflow-hidden"
          >
            {middle}
          </Panel>
          {showRight && (
            <>
              <Separator className={RESIZE_HANDLE_CLASS} />
              <Panel id="right" defaultSize={30} minSize={18} className="overflow-hidden">
                {right}
              </Panel>
            </>
          )}
        </Group>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:hidden">
        <div className="min-h-0 flex-1 overflow-hidden">{middle}</div>
      </div>

      <MobileDrawer
        open={showMobileBacklog}
        side="left"
        onClose={() => backlog.setOpen(false)}
        label="Backlog"
      >
        {left}
      </MobileDrawer>

      {showRight ? (
        <MobileDrawer
          open={showMobileChat}
          side="right"
          onClose={() => chat.setOpen(false)}
          label="Chat"
        >
          {right}
        </MobileDrawer>
      ) : null}
    </>
  );
}

/**
 * Tracks whether the viewport is below the Tailwind `lg` breakpoint
 * (1024px). Returns `null` until the first client effect runs so callers
 * can distinguish "we don't know yet" (pre-hydration) from "yes mobile"
 * vs "no desktop". SSR + first-paint should always match the `null` →
 * desktop default, otherwise we hydrate-mismatch.
 */
function useIsBelowLg(): boolean | null {
  const [below, setBelow] = useState<boolean | null>(null);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 1023.98px)");
    const update = () => setBelow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return below;
}

function MobileDrawer({
  open,
  side,
  onClose,
  label,
  children,
}: {
  open: boolean;
  side: "left" | "right";
  onClose: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <SheetContent side={side} className="flex w-[88vw] max-w-[420px] flex-col p-0 lg:hidden">
        <SheetHeader className="border-b border-border bg-card px-3 py-2">
          <SheetTitle className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            {label}
          </SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
