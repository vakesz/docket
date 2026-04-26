import { TRPCError } from "@trpc/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createCaller } from "@/server/trpc-caller";
import { RefreshCommentsButton } from "@/ui/items/refresh-comments-button";

export default async function ItemDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; itemId: string }>;
}) {
  const { projectId, itemId } = await params;
  const trpc = await createCaller();

  let item: Awaited<ReturnType<typeof trpc.items.get>>;
  try {
    item = await trpc.items.get({ projectId, itemId });
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) {
      notFound();
    }
    throw err;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link
          href={`/projects/${projectId}/items`}
          className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Items
        </Link>
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{item.title}</h1>
          <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs uppercase tracking-wide text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            {item.state}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span className="uppercase tracking-wide">{item.kind}</span>
          <span>{item.providerItemId}</span>
          {item.assignee ? <span>assignee: {item.assignee}</span> : null}
          {item.url ? (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              open at provider ↗
            </a>
          ) : null}
        </div>
      </div>

      {item.descriptionMd ? (
        <article className="whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
          {item.descriptionMd}
        </article>
      ) : (
        <p className="text-sm text-zinc-500 italic">(no description)</p>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Comments</h2>
          <RefreshCommentsButton projectId={projectId} itemId={itemId} />
        </div>
        {item.comments.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-300 p-4 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No comments cached. Click <span className="font-medium">Refresh comments</span> to pull
            from the provider.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {item.comments.map((c) => (
              <li
                key={c.id}
                className="rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800"
              >
                <div className="mb-1 flex items-baseline justify-between gap-2 text-xs text-zinc-500">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    {c.author || "(unknown)"}
                  </span>
                  <time>{c.createdAt.toLocaleString()}</time>
                </div>
                <p className="whitespace-pre-wrap">{c.bodyMd}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
