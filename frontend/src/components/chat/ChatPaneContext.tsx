import { createContext, useCallback, useContext, useEffect, useState } from "react";

// Per-session persistence: chat-open survives client-side route changes but
// resets on a hard reload, so a fresh session always starts with chat closed.
const SESSION_KEY = "docket.chatPaneOpen";

export interface ChatPaneController {
  open: boolean;
  setOpen: (next: boolean) => void;
  // One-shot draft handed to ChatPane (e.g. from "Discuss in chat" on a
  // suggestion). ChatPane reads it once and then calls clearSeed so a stale
  // value can't ambush the next item or thread.
  pendingSeed: string | null;
  seed: (text: string) => void;
  clearSeed: () => void;
}

const NO_OP: ChatPaneController = {
  open: false,
  setOpen: () => {},
  pendingSeed: null,
  seed: () => {},
  clearSeed: () => {},
};

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
  const [pendingSeed, setPendingSeed] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (open) window.sessionStorage.setItem(SESSION_KEY, "1");
    else window.sessionStorage.removeItem(SESSION_KEY);
  }, [open]);

  const setOpen = useCallback((next: boolean) => setOpenState(next), []);
  const seed = useCallback((text: string) => setPendingSeed(text), []);
  const clearSeed = useCallback(() => setPendingSeed(null), []);

  const value: ChatPaneController = { open, setOpen, pendingSeed, seed, clearSeed };

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
