import { TRPCError } from "@trpc/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createCaller } from "@/server/trpc-caller";
import { SyncButton } from "@/ui/items/sync-button";

export default async function ItemsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const search = await searchParams;
  const bucketParam = typeof search.bucket === "string" ? search.bucket : "open";
  const bucket =
    bucketParam === "open" || bucketParam === "closed" || bucketParam === "all"
      ? bucketParam
      : "open";

  const trpc = await createCaller();
  let items: Awaited<ReturnType<typeof trpc.items.list>>;
  try {
    items = await trpc.items.list({ projectId, bucket });
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) {
      notFound();
    }
    throw err;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-semibold tracking-tight">Items</h2>
        <div className="flex items-center gap-2">
          <SyncButton projectId={projectId} mode="incremental" />
          <SyncButton projectId={projectId} mode="full" />
        </div>
      </div>

      <nav className="flex items-center gap-1 text-xs">
        {(["open", "closed", "all"] as const).map((b) => (
          <Link
            key={b}
            href={`/projects/${projectId}/items?bucket=${b}`}
            className={
              bucket === b
                ? "rounded-full bg-zinc-900 px-3 py-1 text-white dark:bg-white dark:text-black"
                : "rounded-full border border-zinc-300 px-3 py-1 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900"
            }
          >
            {b}
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No items in the cache yet — click <span className="font-medium">Refresh</span> to sync
          from the provider.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((it) => (
            <li
              key={it.id}
              className="rounded-md border border-zinc-200 p-3 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
            >
              <Link
                href={`/projects/${projectId}/items/${it.id}`}
                className="flex items-baseline justify-between gap-3"
              >
                <div className="flex-1 truncate">
                  <span className="text-xs uppercase tracking-wide text-zinc-500">{it.kind}</span>
                  <span className="ml-2 text-xs text-zinc-400">{it.providerItemId}</span>
                  <span className="ml-3 font-medium">{it.title}</span>
                </div>
                <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs uppercase tracking-wide text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                  {it.state}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
