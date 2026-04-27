"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

const SESSION_KEY = "docket.chatPaneOpen";

export interface ChatPaneController {
  open: boolean;
  setOpen: (next: boolean) => void;
}

const NO_OP: ChatPaneController = {
  open: false,
  setOpen: () => {},
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

  useEffect(() => {
    setOpenState(readSession());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (open) window.sessionStorage.setItem(SESSION_KEY, "1");
    else window.sessionStorage.removeItem(SESSION_KEY);
  }, [open]);

  const setOpen = useCallback((next: boolean) => setOpenState(next), []);

  return <ChatPaneContext.Provider value={{ open, setOpen }}>{children}</ChatPaneContext.Provider>;
}

export function useChatPaneController(): ChatPaneController {
  return useContext(ChatPaneContext) ?? NO_OP;
}
