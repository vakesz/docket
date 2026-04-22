import { createContext, useCallback, useContext, useEffect, useState } from "react";

// Per-session persistence: chat-open survives client-side route changes but
// resets on a hard reload, so a fresh session always starts with chat closed.
const SESSION_KEY = "docket.chatPaneOpen";

export interface ChatPaneController {
  open: boolean;
  setOpen: (next: boolean) => void;
}

const NO_OP: ChatPaneController = { open: false, setOpen: () => {} };

const ChatPaneContext = createContext<ChatPaneController | null>(null);

function readSession(): boolean {
  if (typeof window === "undefined") return false;
  return window.sessionStorage.getItem(SESSION_KEY) === "1";
}

/**
 * Hosts the chat-pane open/closed state and exposes it via React context.
 *
 * Lives in its own module (rather than alongside the route component) so
 * that any code-splitting or duplicate-import quirks in TanStack Start
 * cannot produce two distinct ChatPaneContext instances — which would make
 * the consumer in `ItemDetail` read `null` and fall back to the no-op
 * setter, swallowing the click silently.
 */
export function ChatPaneProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpenState] = useState<boolean>(readSession);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (open) window.sessionStorage.setItem(SESSION_KEY, "1");
    else window.sessionStorage.removeItem(SESSION_KEY);
  }, [open]);

  const setOpen = useCallback((next: boolean) => setOpenState(next), []);
  const value: ChatPaneController = { open, setOpen };

  return <ChatPaneContext.Provider value={value}>{children}</ChatPaneContext.Provider>;
}

/**
 * Public hook for any component to read or flip the chat-pane state.
 * Outside a `ChatPaneProvider` it returns a no-op so callers don't crash
 * (e.g. when the same component is rendered in a story or a test).
 */
export function useChatPaneController(): ChatPaneController {
  return useContext(ChatPaneContext) ?? NO_OP;
}
