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
      className={cn("hidden text-[10px] text-muted-foreground-faint sm:inline", className)}
      aria-hidden="true"
      title="Open command palette"
    >
      Press {mac ? "⌘" : "Ctrl"}+K for command palette
    </span>
  );
}
