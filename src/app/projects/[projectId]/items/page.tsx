import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";
import { createCaller } from "@/server/trpc-caller";
import { SyncButton } from "@/ui/items/sync-button";
import { ViewBar } from "@/ui/views/view-bar";

/**
 * Renders into the *middle* slot of the items shell — the BacklogPane is
 * always visible on the left via the surrounding `layout.tsx`. With no
 * item selected, this is the spot for project-wide controls (sync, saved
 * views) and a friendly nudge to pick something from the backlog.
 */
export default async function ItemsLandingPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const trpc = await createCaller();
  try {
    await trpc.projects.get({ projectId });
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) {
      notFound();
    }
    throw err;
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg p-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold tracking-tight">Items</h2>
          <div className="flex items-center gap-2">
            <SyncButton projectId={projectId} mode="incremental" />
            <SyncButton projectId={projectId} mode="full" />
          </div>
        </div>
        <ViewBar projectId={projectId} />
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-fg-faint">
          Pick an item from the backlog on the left, or sync from the provider to populate it.
        </p>
      </div>
    </div>
  );
}
