"use client";

import { useEffect, useState } from "react";
import { isMacLike } from "@/lib/platform";
import { cn } from "@/lib/utils";

/**
 * Right-aligned discoverability hint advertising the Cmd/Ctrl+K palette.
 * Renders a stable Ctrl placeholder during SSR and switches to ⌘ on Mac
 * after hydration so the server payload matches every client and the
 * mismatch is constrained to this small island.
 */
export function PaletteHint({ className }: { className?: string }) {
  const [mac, setMac] = useState(false);

  useEffect(() => {
    setMac(isMacLike());
  }, []);

  return (
    <span
      className={cn(
        "hidden items-center gap-1 font-mono text-[10px] text-fg-faint sm:inline-flex",
        className,
      )}
      aria-hidden="true"
      title="Open command palette"
    >
      <kbd className="rounded border border-border bg-bg px-1.5 py-0.5">{mac ? "⌘" : "Ctrl"}</kbd>
      <span className="text-fg-faint">+</span>
      <kbd className="rounded border border-border bg-bg px-1.5 py-0.5">K</kbd>
    </span>
  );
}
