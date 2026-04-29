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
  projectSlug,
  readOnly = false,
  variant,
}: {
  projectSlug: string | null;
  readOnly?: boolean;
  variant: "topbar" | "footer";
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const sync = trpc.items.runSync.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.items.list.invalidate(),
        projectSlug ? utils.items.syncStatus.invalidate({ projectSlug }) : Promise.resolve(),
      ]);
      router.refresh();
    },
  });
  // Share the in-flight signal across every SyncButton mounted in the
  // tree by filtering on the canonical trpc mutation key. Without this,
  // clicking the topbar glyph wouldn't spin the footer icon (and vice
  // versa) because each `useMutation` keeps its own pending flag.
  const inflightCount = useIsMutating({ mutationKey: getMutationKey(trpc.items.runSync) });
  const inflight = inflightCount > 0 || sync.isPending;
  const canSync = Boolean(projectSlug) && !readOnly;
  const disabled = !canSync || inflight;
  const title = readOnly ? "Read-only mode — sync disabled" : inflight ? "Syncing…" : "Sync now";

  const onClick = () => {
    if (!projectSlug || inflight) return;
    sync.mutate({ projectSlug, mode: "incremental" });
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
          "shrink-0 cursor-pointer text-muted-foreground transition-colors",
          "hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground",
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
          "inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors",
          "hover:border-border hover:bg-muted hover:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
          "focus:outline-none focus:ring-1 focus:ring-ring",
        )}
      >
        <RefreshCw aria-hidden="true" className={cn("h-3 w-3", inflight && "animate-spin")} />
      </button>
      {sync.error ? (
        <span className="text-destructive" title={sync.error.message}>
          · sync failed
        </span>
      ) : null}
    </>
  );
}
