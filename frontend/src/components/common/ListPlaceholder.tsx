import type { ReactNode } from "react";

import { cn } from "~/lib/cn";

/**
 * Centered helper text inside a sidebar list — loading, empty, or error.
 * Matches the visual rhythm used across MemoryPage, SourcesPage, McpPage,
 * and PromptsPanel sidebars; keep callers aligned by routing through this
 * component.
 */
export function ListPlaceholder({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "error";
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "px-3 py-6 text-center text-xs",
        tone === "error" ? "text-danger" : "text-fg-muted",
      )}
    >
      {children}
    </p>
  );
}
