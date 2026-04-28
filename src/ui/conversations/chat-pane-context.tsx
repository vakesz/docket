"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const SESSION_KEY = "docket.chatPaneOpen";

export interface ChatPaneController {
  open: boolean;
  setOpen: (next: boolean) => void;
  /**
   * Single-shot seed message to auto-fire into the chat pane on the next
   * render. Set via `requestOpenWithSeed`. Only present as a re-render
   * trigger; the actual value must be claimed atomically via `claimSeed`.
   */
  pendingSeed: string | null;
  /**
   * True from the moment a seed is requested until a consumer claims it.
   * Buttons that enqueue seeds (e.g. SuggestActionButton) read this so a
   * rapid second tap doesn't enqueue a duplicate before the chat picks
   * up the first one.
   */
  seedPending: boolean;
  /**
   * Open the pane and queue a seed message to auto-submit. No-op while a
   * previously requested seed has not yet been claimed — protects against
   * accidental double-taps spawning duplicate conversations.
   */
  requestOpenWithSeed: (seed: string) => void;
  /**
   * Atomically claim the queued seed; returns the seed string on the
   * first call after a `requestOpenWithSeed`, and `null` on every
   * subsequent call (including from a duplicate ChatPane mount that
   * runs the same seed effect in parallel).
   */
  claimSeed: () => string | null;
}

const NO_OP: ChatPaneController = {
  open: false,
  setOpen: () => {},
  pendingSeed: null,
  seedPending: false,
  requestOpenWithSeed: () => {},
  claimSeed: () => null,
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
 *
 * Seed handoff: the suggest-button stages a one-shot prompt via
 * `requestOpenWithSeed`; the chat pane consumes it via `claimSeed` on its
 * next render. The claim is ref-backed so a doubly-mounted ChatPane (one
 * in the desktop layout + one inside MobileDrawer when both happen to be
 * mounted) can't both fire the same seed. Same ref also gates
 * `requestOpenWithSeed` against rapid double-taps.
 */
export function ChatPaneProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpenState] = useState<boolean>(false);
  const [pendingSeed, setPendingSeedState] = useState<string | null>(null);
  const seedRef = useRef<string | null>(null);

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
    if (seedRef.current !== null) {
      if (process.env.NODE_ENV !== "production") {
        console.debug("[chat-pane] requestOpenWithSeed: ignoring duplicate tap", {
          pendingLen: seedRef.current.length,
        });
      }
      return;
    }
    seedRef.current = seed;
    setOpenState(true);
    setPendingSeedState(seed);
  }, []);

  const claimSeed = useCallback((): string | null => {
    const claimed = seedRef.current;
    if (claimed === null) return null;
    seedRef.current = null;
    setPendingSeedState(null);
    return claimed;
  }, []);

  return (
    <ChatPaneContext.Provider
      value={{
        open,
        setOpen,
        pendingSeed,
        seedPending: pendingSeed !== null,
        requestOpenWithSeed,
        claimSeed,
      }}
    >
      {children}
    </ChatPaneContext.Provider>
  );
}

export function useChatPaneController(): ChatPaneController {
  return useContext(ChatPaneContext) ?? NO_OP;
}
