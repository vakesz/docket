"use client";

import Link from "next/link";
import { trpc } from "@/lib/trpc-client";

/**
 * Sidebar pane listing the user's pinned items in this project. Pinned
 * items render even if they fall outside the active scope filter — that's
 * the point of pinning.
 */
export function WatchlistPane({ projectId }: { projectId: string }) {
  const list = trpc.watchlist.list.useQuery({ projectId, limit: 50 }, { staleTime: 0 });

  return (
    <aside className="flex flex-col gap-2">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Watchlist
      </h2>
      {list.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : list.data && list.data.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {list.data.map((entry) => (
            <li key={entry.pinId}>
              <Link
                href={`/projects/${projectId}/items/${entry.item.id}`}
                className="flex items-baseline justify-between gap-2 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-muted"
              >
                <span className="flex-1 truncate">
                  <span className="text-muted-foreground">{entry.item.providerItemId}</span>
                  <span className="ml-2 font-medium">{entry.item.title}</span>
                </span>
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {entry.item.state}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground italic">
          No pins yet. Open an item and click <span className="font-medium">Pin</span>.
        </p>
      )}
    </aside>
  );
}
