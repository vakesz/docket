"use client";

import { useIsMutating } from "@tanstack/react-query";
import { getMutationKey } from "@trpc/react-query";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";

/**
 * Shared incremental-sync trigger. Mounted in the topbar (glyph-only,
 * left of the project switcher) and inside the status footer. Both
 * instances watch the same `items.runSync` mutation key via
 * `useIsMutating`, so triggering either one spins both icons until the
 * request settles. Read-only mode disables the button with an
 * explanatory title.
 */
export function SyncButton({
  projectId,
  readOnly = false,
  variant,
}: {
  projectId: string | null;
  readOnly?: boolean;
  variant: "topbar" | "footer";
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const sync = trpc.items.runSync.useMutation({
    onSuccess: async () => {
      await utils.items.list.invalidate();
      router.refresh();
    },
  });
  // Share the in-flight signal across every SyncButton mounted in the
  // tree by filtering on the canonical trpc mutation key. Without this,
  // clicking the topbar glyph wouldn't spin the footer icon (and vice
  // versa) because each `useMutation` keeps its own pending flag.
  const inflightCount = useIsMutating({ mutationKey: getMutationKey(trpc.items.runSync) });
  const inflight = inflightCount > 0 || sync.isPending;
  const canSync = Boolean(projectId) && !readOnly;
  const disabled = !canSync || inflight;
  const title = readOnly ? "Read-only mode — sync disabled" : inflight ? "Syncing…" : "Sync now";

  const onClick = () => {
    if (!projectId || inflight) return;
    sync.mutate({ projectId, mode: "incremental" });
  };

  if (variant === "topbar") {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label="Sync now"
        title={title}
        className={cn(
          "shrink-0 cursor-pointer text-fg-muted transition-colors",
          "hover:text-fg focus:outline-none focus:ring-1 focus:ring-accent",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-fg-muted",
        )}
      >
        <RefreshCw aria-hidden="true" className={cn("h-3 w-3", inflight && "animate-spin")} />
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label="Sync now"
        title={title}
        className={cn(
          "inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-md border border-transparent text-fg-muted transition-colors",
          "hover:border-border hover:bg-surface-alt hover:text-fg",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-fg-muted",
          "focus:outline-none focus:ring-1 focus:ring-accent",
        )}
      >
        <RefreshCw aria-hidden="true" className={cn("h-3 w-3", inflight && "animate-spin")} />
      </button>
      {sync.error ? (
        <span className="text-danger-fg" title={sync.error.message}>
          · sync failed
        </span>
      ) : null}
    </>
  );
}
