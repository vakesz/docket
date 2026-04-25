// Browser-local UI preferences. Stored alongside the theme key so they don't
// leak to the backend or bleed into the TUI.

import { useEffect, useState } from "react";

export const TOOL_DISPLAY_KEY = "docket.chat.toolDisplay";

export type ToolDisplayMode = "show" | "collapse" | "hide";

const VALID: ReadonlySet<string> = new Set(["show", "collapse", "hide"]);

export function readToolDisplayMode(): ToolDisplayMode {
  if (typeof window === "undefined") return "collapse";
  const raw = window.localStorage.getItem(TOOL_DISPLAY_KEY);
  return raw && VALID.has(raw) ? (raw as ToolDisplayMode) : "collapse";
}

export function writeToolDisplayMode(value: ToolDisplayMode): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOOL_DISPLAY_KEY, value);
  window.dispatchEvent(new CustomEvent("docket:uiprefs"));
}

export function useToolDisplayMode(): [ToolDisplayMode, (v: ToolDisplayMode) => void] {
  // Always start with the default so SSR and first-paint agree; the effect
  // below pulls the real value once we're on the client.
  const [value, setValue] = useState<ToolDisplayMode>("collapse");

  useEffect(() => {
    setValue(readToolDisplayMode());
    const onChange = () => setValue(readToolDisplayMode());
    window.addEventListener("storage", onChange);
    window.addEventListener("docket:uiprefs", onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener("docket:uiprefs", onChange);
    };
  }, []);

  const set = (v: ToolDisplayMode) => {
    writeToolDisplayMode(v);
    setValue(v);
  };

  return [value, set];
}
