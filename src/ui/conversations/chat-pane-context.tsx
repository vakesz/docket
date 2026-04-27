"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

const SESSION_KEY = "docket.chatPaneOpen";

export interface ChatPaneController {
  open: boolean;
  setOpen: (next: boolean) => void;
  /**
   * Single-shot seed message to auto-fire into the chat pane on the next
   * render. Set via `requestOpenWithSeed`; the consumer (`ChatPane`) reads
   * it and immediately calls `consumeSeed()` so a remount can't replay it.
   */
  pendingSeed: string | null;
  /** Open the pane and queue a seed message to auto-submit. */
  requestOpenWithSeed: (seed: string) => void;
  /** Mark the pending seed as consumed; called by ChatPane after dispatch. */
  consumeSeed: () => void;
}

const NO_OP: ChatPaneController = {
  open: false,
  setOpen: () => {},
  pendingSeed: null,
  requestOpenWithSeed: () => {},
  consumeSeed: () => {},
};

const ChatPaneContext = createContext<ChatPaneController | null>(null);

function readSession(): boolean {
  if (typeof window === "undefined") return false;
  return window.sessionStorage.getItem(SESSION_KEY) === "1";
}

/**
 * Hosts the chat-pane open/closed state. Lives at the items shell so the
 * choice survives item-switches but resets per browser session — the
 * default state on a fresh tab is closed, and the chat opens via the
 * toggle inside the item detail header.
 */
export function ChatPaneProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpenState] = useState<boolean>(false);
  const [pendingSeed, setPendingSeed] = useState<string | null>(null);

  useEffect(() => {
    setOpenState(readSession());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (open) window.sessionStorage.setItem(SESSION_KEY, "1");
    else window.sessionStorage.removeItem(SESSION_KEY);
  }, [open]);

  const setOpen = useCallback((next: boolean) => setOpenState(next), []);

  const requestOpenWithSeed = useCallback((seed: string) => {
    setOpenState(true);
    setPendingSeed(seed);
  }, []);

  const consumeSeed = useCallback(() => {
    setPendingSeed(null);
  }, []);

  return (
    <ChatPaneContext.Provider
      value={{ open, setOpen, pendingSeed, requestOpenWithSeed, consumeSeed }}
    >
      {children}
    </ChatPaneContext.Provider>
  );
}

export function useChatPaneController(): ChatPaneController {
  return useContext(ChatPaneContext) ?? NO_OP;
}
