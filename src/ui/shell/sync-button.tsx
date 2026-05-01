"use client";

import { useIsMutating } from "@tanstack/react-query";
import { getMutationKey } from "@trpc/react-query";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";

/**
 * Shared incremental-sync trigger. Mounted in the topbar (glyph-only,
 * left of the project switcher) and inside the status footer.
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
    onMutate: async () => {
      if (!projectSlug) return;
      await utils.items.syncStatus.invalidate({ projectSlug });
    },
    onSuccess: async () => {
      await Promise.all([
        utils.items.list.invalidate(),
        projectSlug ? utils.items.syncStatus.invalidate({ projectSlug }) : Promise.resolve(),
      ]);
      router.refresh();
    },
  });

  const inflightCount = useIsMutating({
    mutationKey: getMutationKey(trpc.items.runSync),
  });
  const inflight = inflightCount > 0 || sync.isPending;
  const canSync = Boolean(projectSlug) && !readOnly;
  const disabled = !canSync || inflight;
  const title = readOnly ? "Read-only mode — sync disabled" : inflight ? "Syncing…" : "Sync now";

  const onClick = () => {
    if (!projectSlug || inflight || readOnly) return;
    sync.mutate({ projectSlug, mode: "incremental" });
  };

  const buttonClass =
    variant === "topbar"
      ? cn(
          "shrink-0 cursor-pointer text-muted-foreground transition-colors",
          "hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground",
        )
      : cn(
          "inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors",
          "hover:border-border hover:bg-muted hover:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
          "focus:outline-none focus:ring-1 focus:ring-ring",
        );

  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Sync now"
      title={title}
      className={buttonClass}
    >
      <RefreshCw aria-hidden="true" className={cn("h-3 w-3", inflight && "animate-spin")} />
    </button>
  );

  if (variant === "topbar") return button;

  return (
    <>
      {button}
      {sync.error ? (
        <span className="text-destructive" title={sync.error.message}>
          · sync failed
        </span>
      ) : null}
    </>
  );
}
