"use client";

import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { SEPARATOR } from "@/lib/form-classes";
import { cn } from "@/lib/utils";
import { useChatPaneController } from "@/ui/conversations/chat-pane-context";
import { useRegisterSidebarMount, useSidebarDrawer } from "@/ui/shell/sidebar-drawer-context";

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

  // Headless UI's Dialog mounts its portal + children whenever `open=true`,
  // even when the dialog itself is display:none via `lg:hidden`. On lg+ that
  // double-mounts ChatPane (once in the desktop Group, once inside the
  // hidden Dialog) AND lets the Dialog's outside-click logic fire onClose
  // moments after opening — the visible "pops up then closes instantly"
  // bug. Gate the Dialog `open` on viewport so it stays unmounted on lg+.
  // `null` (pre-hydration) is treated as "not below lg" so SSR markup
  // matches the desktop default and the Dialog doesn't briefly mount on
  // first paint.
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
          <Separator className={cn("w-px", SEPARATOR)} />
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
              <Separator className={cn("w-px", SEPARATOR)} />
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
    <Dialog open={open} onClose={onClose} className="relative z-40 lg:hidden">
      <DialogBackdrop className="fixed inset-0 bg-fg/30 backdrop-blur-sm" />
      <div className="fixed inset-0 flex">
        <DialogPanel
          className={cn(
            "absolute inset-y-0 flex w-[88vw] max-w-[420px] flex-col overflow-hidden border-border bg-bg shadow-xl",
            side === "left" ? "left-0 border-r" : "right-0 border-l",
          )}
        >
          <div className="flex items-center justify-between border-b border-border bg-surface px-3 py-2">
            <DialogTitle className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-muted">
              {label}
            </DialogTitle>
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close ${label.toLowerCase()}`}
              className="rounded-md p-1 text-fg-muted hover:bg-surface-alt hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
