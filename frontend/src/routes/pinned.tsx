import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { usePinned } from "~/api/hooks";
import { StatePill } from "~/components/items/ItemsList";
import { formatKind, formatRelative } from "~/lib/format";

export const Route = createFileRoute("/pinned")({
  component: PinnedPage,
});

function PinnedPage() {
  const pinned = usePinned();
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-3 overflow-auto p-6">
      <header className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold">Pinned</h1>
        <span className="font-mono text-[11px] text-zinc-500">
          {pinned.data?.length ?? 0} items
        </span>
      </header>

      {pinned.isPending && <div className="text-sm text-zinc-500">Loading…</div>}
      {pinned.data?.length === 0 && (
        <div className="rounded border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
          Nothing pinned yet. Pin items from the detail pane to watch them across syncs.
        </div>
      )}

      <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
        {pinned.data?.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              onClick={() => navigate({ to: "/items/$itemId", params: { itemId: it.id } })}
              className="flex w-full items-center gap-3 py-3 text-left hover:text-accent"
            >
              <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                {formatKind(it.kind)}
              </span>
              <StatePill state={it.state} />
              <span className="flex-1 truncate text-sm">{it.title}</span>
              <span className="font-mono text-[10px] text-zinc-400">
                {formatRelative(it.updated_at)}
              </span>
              <span className="font-mono text-[10px] text-zinc-400">#{it.id}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
