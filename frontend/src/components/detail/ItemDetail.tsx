import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { DTO } from "~/api/client";
import { useComments, useItem, useLinked, useRefreshItem } from "~/api/hooks";
import { FreshnessStamp, useStaleThreshold } from "~/components/items/ItemFreshness";
import { StatePill } from "~/components/items/ItemsList";
import { ProposalCard } from "~/components/mutations/ProposalCard";
import { cn } from "~/lib/cn";
import { displayTag, formatKind, formatRelative } from "~/lib/format";
import { issueLinkContextFromUrl } from "~/lib/issueLinks";
import { CommentComposer } from "./CommentComposer";
import { DescriptionEditor } from "./DescriptionEditor";
import { Markdown } from "./Markdown";
import { PinButton } from "./PinButton";
import { SuggestBlock } from "./SuggestBlock";
import { TransitionBar } from "./TransitionBar";

interface Props {
  itemId: string;
}

const metaLabelClassName = "font-mono text-[10px] uppercase tracking-wider text-zinc-500";

export function ItemDetail({ itemId }: Props) {
  const item = useItem(itemId);
  const refresh = useRefreshItem();
  const staleThresholdDays = useStaleThreshold();
  const [editing, setEditing] = useState(false);
  const [proposals, setProposals] = useState<DTO["ProposalDTO"][]>([]);

  const pushProposal = (p: DTO["ProposalDTO"]) =>
    setProposals((prev) => [...prev.filter((x) => x.id !== p.id), p]);
  const pushProposals = (list: DTO["ProposalDTO"][]) => setProposals((prev) => [...prev, ...list]);
  const dismissProposal = (id: string) => setProposals((prev) => prev.filter((p) => p.id !== id));

  if (item.isPending) {
    return <CenterText text="Loading…" />;
  }
  if (item.error) {
    return <CenterText text={item.error.message} tone="error" />;
  }
  if (!item.data) {
    return <CenterText text="Item not found." />;
  }

  const it = item.data;
  const issueLinks = issueLinkContextFromUrl(it.url);

  return (
    <div className="flex h-full flex-col overflow-auto bg-white dark:bg-zinc-950">
      <header className="flex flex-col gap-2 border-b border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
            {formatKind(it.kind)}
          </span>
          <StatePill state={it.state} />
          <span className="font-mono text-[10px] text-zinc-400">#{it.id}</span>
          <span className="inline-flex items-center gap-1">
            <span className="font-mono text-[10px] text-zinc-400">Updated</span>
            <FreshnessStamp updatedAt={it.updated_at} thresholdDays={staleThresholdDays} />
          </span>
          <div className="ml-auto flex items-center gap-2">
            <PinButton itemId={it.id} />
            <button
              type="button"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate(it.id)}
              className="rounded border border-zinc-200 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900"
            >
              {refresh.isPending ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
        <h1 className="text-lg font-semibold leading-snug text-zinc-900 dark:text-zinc-100">
          {it.title}
        </h1>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
          {it.author && (
            <>
              <dt className={metaLabelClassName}>Opened by</dt>
              <dd className="text-zinc-700 dark:text-zinc-300">{it.author}</dd>
            </>
          )}
          <dt className={metaLabelClassName}>Assignee</dt>
          <dd className={cn(!it.assignee && "italic text-zinc-400 dark:text-zinc-600")}>
            {it.assignee ?? "Unassigned"}
          </dd>
          {it.parent_id && (
            <>
              <dt className={metaLabelClassName}>Parent</dt>
              <dd>
                <ParentLink id={it.parent_id} />
              </dd>
            </>
          )}
          {(it.tags?.length ?? 0) > 0 && (
            <>
              <dt className={metaLabelClassName}>Labels</dt>
              <dd className="flex flex-wrap gap-1">
                {it.tags?.map((tag) => (
                  <span
                    key={tag}
                    title={tag}
                    className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
                  >
                    {displayTag(tag)}
                  </span>
                ))}
              </dd>
            </>
          )}
          {(it.attachments?.length ?? 0) > 0 && (
            <>
              <dt className={metaLabelClassName}>Attachments</dt>
              <dd>{it.attachments?.length}</dd>
            </>
          )}
          {it.url && (
            <>
              <dt className={metaLabelClassName}>Link</dt>
              <dd>
                <a
                  href={it.url}
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
        <div className="flex flex-col gap-1.5 pt-1">
          <div className="flex items-center gap-2">
            <h2 className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              Actions
            </h2>
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
              tap to stage a proposal — nothing is written until you confirm
            </span>
          </div>
          <TransitionBar itemId={it.id} onStaged={pushProposal} />
        </div>
      </header>

      {proposals.length > 0 && (
        <div className="flex flex-col gap-2 border-b border-zinc-200 p-3 dark:border-zinc-800">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} onResolved={() => dismissProposal(p.id)} />
          ))}
        </div>
      )}

      <section className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">
            Description
          </h2>
          {!editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="ml-auto rounded border border-zinc-200 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900"
            >
              Edit
            </button>
          )}
        </div>
        {editing ? (
          <DescriptionEditor
            itemId={it.id}
            initial={it.description_md ?? ""}
            onStaged={pushProposal}
            onClose={() => setEditing(false)}
          />
        ) : (
          <Markdown source={it.description_md ?? ""} issueLinks={issueLinks} />
        )}
      </section>

      <section className="flex flex-col gap-3 border-t border-zinc-200 p-4 dark:border-zinc-800">
        <SuggestBlock itemId={it.id} onStaged={pushProposals} />
      </section>

      <CommentsSection itemId={it.id} issueUrl={it.url} onStaged={pushProposal} />
      <LinkedSection itemId={it.id} />
    </div>
  );
}

function ParentLink({ id }: { id: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate({ to: "/items/$itemId", params: { itemId: id } })}
      className="text-accent hover:underline"
    >
      Parent: {id}
    </button>
  );
}

function CommentsSection({
  itemId,
  issueUrl,
  onStaged,
}: {
  itemId: string;
  issueUrl?: string | null;
  onStaged: (proposal: DTO["ProposalDTO"]) => void;
}) {
  const comments = useComments(itemId);
  const issueLinks = issueLinkContextFromUrl(issueUrl);
  return (
    <section className="flex flex-col gap-3 border-t border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">
        Comments ({comments.data?.length ?? 0})
      </h2>
      {comments.isPending && <div className="text-xs text-zinc-500">Loading…</div>}
      {comments.data?.length === 0 && (
        <div className="text-xs italic text-zinc-400">No comments.</div>
      )}
      <ul className="flex flex-col gap-3">
        {comments.data?.map((c) => (
          <li key={c.id} className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="mb-1 flex items-center gap-2 text-xs text-zinc-500">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">{c.author}</span>
              <span className="font-mono text-[10px]">{formatRelative(c.created_at)}</span>
            </div>
            <Markdown source={c.body_md} issueLinks={issueLinks} />
          </li>
        ))}
      </ul>
      <CommentComposer itemId={itemId} onStaged={onStaged} />
    </section>
  );
}

function LinkedSection({ itemId }: { itemId: string }) {
  const linked = useLinked(itemId);
  const navigate = useNavigate();
  if (!linked.data?.length) return null;
  return (
    <section className="flex flex-col gap-2 border-t border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">Linked items</h2>
      <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
        {linked.data.map((lk) => (
          <li key={lk.id}>
            <button
              type="button"
              onClick={() => navigate({ to: "/items/$itemId", params: { itemId: lk.id } })}
              className="flex w-full items-center gap-2 py-1.5 text-left text-sm hover:text-accent"
            >
              <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                {formatKind(lk.kind)}
              </span>
              <StatePill state={lk.state} />
              <span className="truncate">{lk.title}</span>
              <span className="ml-auto font-mono text-[10px] text-zinc-400">#{lk.id}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CenterText({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <div
      className={cn(
        "flex h-full items-center justify-center p-4 text-sm",
        tone === "error" ? "text-rose-600 dark:text-rose-400" : "text-zinc-500",
      )}
    >
      {text}
    </div>
  );
}
