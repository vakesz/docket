import Link from "next/link";
import type { ItemState } from "@/core/types";
import { metaLabelClass } from "@/lib/form-classes";
import { displayTag, formatKind, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FreshnessStamp } from "@/ui/items/freshness";
import { ItemActions } from "@/ui/items/item-actions";
import { PinButton } from "@/ui/items/pin-button";
import { RefreshCommentsButton } from "@/ui/items/refresh-comments-button";
import { StatePill } from "@/ui/items/state-pill";

type Comment = {
  id: string;
  author: string | null;
  bodyMd: string;
  createdAt: Date;
};

type DetailItem = {
  id: string;
  providerItemId: string;
  kind: string;
  title: string;
  state: string;
  assignee: string | null;
  author: string | null;
  parentId: string | null;
  tags: string[];
  url: string | null;
  descriptionMd: string | null;
  updatedAt: Date;
  comments: Comment[];
};

/**
 * Middle pane of the workspace shell: full item detail with header, meta
 * grid, description, action bar, and comment thread.
 *
 * The pane is a server component so the initial render carries the full
 * detail without a client round-trip; interactive bits (pin, refresh
 * comments, transition/comment proposals) come from existing client
 * islands so this file stays mostly markup.
 *
 * TODO(port): rich-markdown rendering for the description and comment
 * bodies (main uses a remark/rehype + highlight.js stack). For now the
 * raw markdown shows as preformatted text, which is readable but loses
 * code-block syntax highlighting and link rendering.
 */
export function DetailPane({
  projectId,
  item,
  staleThresholdDays,
}: {
  projectId: string;
  item: DetailItem;
  staleThresholdDays: number | null;
}) {
  return (
    <div className="flex h-full flex-col overflow-auto bg-bg">
      <header className="flex flex-col gap-2 border-b border-border p-4">
        <div className="flex items-center gap-2 text-xs">
          <span className={metaLabelClass}>{formatKind(item.kind)}</span>
          <StatePill state={item.state} />
          <span className="font-mono text-[10px] text-fg-faint">{item.providerItemId}</span>
          <span className="inline-flex items-center gap-1">
            <span className="font-mono text-[10px] text-fg-faint">Updated</span>
            <FreshnessStamp updatedAt={item.updatedAt} thresholdDays={staleThresholdDays} />
          </span>
          <div className="ml-auto flex items-center gap-2">
            <PinButton projectId={projectId} providerItemId={item.providerItemId} />
            <RefreshCommentsButton projectId={projectId} itemId={item.id} />
          </div>
        </div>
        <h1 className="text-lg font-semibold leading-snug text-fg">{item.title}</h1>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-fg-muted">
          {item.author && (
            <>
              <dt className={metaLabelClass}>Opened by</dt>
              <dd className="text-fg">{item.author}</dd>
            </>
          )}
          <dt className={metaLabelClass}>Assignee</dt>
          <dd className={cn(!item.assignee && "italic text-fg-faint")}>
            {item.assignee ?? "Unassigned"}
          </dd>
          {item.parentId && (
            <>
              <dt className={metaLabelClass}>Parent</dt>
              <dd>
                <Link
                  href={`/projects/${projectId}/items/${item.parentId}`}
                  className="text-accent hover:underline"
                >
                  Parent: {item.parentId}
                </Link>
              </dd>
            </>
          )}
          {item.tags.length > 0 && (
            <>
              <dt className={metaLabelClass}>Labels</dt>
              <dd className="flex flex-wrap gap-1">
                {item.tags.map((tag) => (
                  <span
                    key={tag}
                    title={tag}
                    className="rounded bg-surface-alt px-1.5 py-0.5 font-mono text-[10px] text-fg-muted"
                  >
                    {displayTag(tag)}
                  </span>
                ))}
              </dd>
            </>
          )}
          {item.url && (
            <>
              <dt className={metaLabelClass}>Link</dt>
              <dd>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-accent hover:underline"
                >
                  Open in provider ↗
                </a>
              </dd>
            </>
          )}
        </dl>
      </header>

      <section className="flex flex-col gap-3 p-4">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-fg-muted">
          Description
        </h2>
        {item.descriptionMd ? (
          <article className="whitespace-pre-wrap rounded-md border border-border bg-surface p-3 text-sm text-fg">
            {item.descriptionMd}
          </article>
        ) : (
          <p className="text-sm italic text-fg-faint">(no description)</p>
        )}
      </section>

      <section className="border-t border-border p-4">
        <ItemActions
          projectId={projectId}
          providerItemId={item.providerItemId}
          state={item.state as ItemState}
        />
      </section>

      <section className="flex flex-col gap-3 border-t border-border p-4">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-fg-muted">
          Comments ({item.comments.length})
        </h2>
        {item.comments.length === 0 ? (
          <p className="text-sm italic text-fg-faint">No comments cached.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {item.comments.map((c) => (
              <li key={c.id} className="rounded border border-border p-3">
                <div className="mb-1 flex items-baseline justify-between gap-2 text-xs text-fg-muted">
                  <span className="font-medium text-fg">{c.author ?? "(unknown)"}</span>
                  <time
                    dateTime={c.createdAt.toISOString()}
                    title={c.createdAt.toLocaleString()}
                    className="font-mono text-[10px]"
                  >
                    {formatRelative(c.createdAt)}
                  </time>
                </div>
                <p className="whitespace-pre-wrap text-sm text-fg">{c.bodyMd}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
