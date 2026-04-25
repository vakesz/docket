import { useEffect } from "react";

/**
 * Fire `onEscape` whenever the Escape key is pressed at the window level.
 * Used by every modal in the app to close on Esc — without it, each
 * caller spelled the same `keydown` listener inside a `useEffect`.
 */
export function useEscapeKey(onEscape: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscape]);
}
