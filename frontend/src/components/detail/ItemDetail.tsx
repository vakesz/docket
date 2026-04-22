import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { DTO } from "~/api/client";
import { useComments, useItem, useLinked, useRefreshItem } from "~/api/hooks";
import { useChatPaneController } from "~/components/chat/ChatPaneContext";
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

const metaLabelClassName = "font-mono text-[10px] uppercase tracking-wider text-fg-muted";

export function ItemDetail({ itemId }: Props) {
  const item = useItem(itemId);
  const refresh = useRefreshItem();
  const chatController = useChatPaneController();
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
    <div className="flex h-full flex-col overflow-auto bg-bg">
      <header className="flex flex-col gap-2 border-b border-border p-4">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
            {formatKind(it.kind)}
          </span>
          <StatePill state={it.state} />
          <span className="font-mono text-[10px] text-fg-faint">#{it.id}</span>
          <span className="inline-flex items-center gap-1">
            <span className="font-mono text-[10px] text-fg-faint">Updated</span>
            <FreshnessStamp updatedAt={it.updated_at} thresholdDays={staleThresholdDays} />
          </span>
          <div className="ml-auto flex items-center gap-2">
            {/*
              Always rendered (toggle, not "open-only") so Safari can't
              cancel the click event by detaching the button mid-dispatch
              when chatController.open flips. Gating on status.chat_enabled
              is intentionally omitted; if the backend reports chat
              disabled the pane itself surfaces the disabled state.
            */}
            <button
              type="button"
              onClick={() => chatController.setOpen(!chatController.open)}
              title={chatController.open ? "Close chat" : "Open chat about this item"}
              aria-pressed={chatController.open}
              className={cn(
                "rounded border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider transition-colors",
                chatController.open
                  ? "border-accent bg-accent text-accent-fg hover:bg-accent/90"
                  : "border-accent bg-accent/10 text-accent hover:bg-accent/20",
              )}
            >
              {chatController.open ? "✕ Chat" : "💬 Chat"}
            </button>
            <PinButton itemId={it.id} />
            <button
              type="button"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate(it.id)}
              className="rounded border border-border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-fg-muted hover:bg-surface-alt"
            >
              {refresh.isPending ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
        <h1 className="text-lg font-semibold leading-snug text-fg">{it.title}</h1>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-fg-muted">
          {it.author && (
            <>
              <dt className={metaLabelClassName}>Opened by</dt>
              <dd className="text-fg">{it.author}</dd>
            </>
          )}
          <dt className={metaLabelClassName}>Assignee</dt>
          <dd className={cn(!it.assignee && "italic text-fg-faint")}>
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
                    className="rounded bg-surface-alt px-1.5 py-0.5 font-mono text-[10px] text-fg-muted"
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
            <h2 className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
              Actions
            </h2>
            <span className="text-[11px] text-fg-muted">
              tap to stage a proposal — nothing is written until you confirm
            </span>
          </div>
          <TransitionBar itemId={it.id} onStaged={pushProposal} />
        </div>
      </header>

      {proposals.length > 0 && (
        <div className="flex flex-col gap-2 border-b border-border p-3">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} onResolved={() => dismissProposal(p.id)} />
          ))}
        </div>
      )}

      <section className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-fg-muted">
            Description
          </h2>
          {!editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="ml-auto rounded border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted hover:bg-surface-alt"
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

      <section className="flex flex-col gap-3 border-t border-border p-4">
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
    <section className="flex flex-col gap-3 border-t border-border p-4">
      <h2 className="font-mono text-[11px] uppercase tracking-wider text-fg-muted">
        Comments ({comments.data?.length ?? 0})
      </h2>
      {comments.isPending && <div className="text-xs text-fg-muted">Loading…</div>}
      {comments.data?.length === 0 && (
        <div className="text-xs italic text-fg-faint">No comments.</div>
      )}
      <ul className="flex flex-col gap-3">
        {comments.data?.map((c) => (
          <li key={c.id} className="rounded border border-border p-3">
            <div className="mb-1 flex items-center gap-2 text-xs text-fg-muted">
              <span className="font-medium text-fg">{c.author}</span>
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
    <section className="flex flex-col gap-2 border-t border-border p-4">
      <h2 className="font-mono text-[11px] uppercase tracking-wider text-fg-muted">Linked items</h2>
      <ul className="flex flex-col divide-y divide-border">
        {linked.data.map((lk) => (
          <li key={lk.id}>
            <button
              type="button"
              onClick={() => navigate({ to: "/items/$itemId", params: { itemId: lk.id } })}
              className="flex w-full items-center gap-2 py-1.5 text-left text-sm hover:text-accent"
            >
              <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                {formatKind(lk.kind)}
              </span>
              <StatePill state={lk.state} />
              <span className="truncate">{lk.title}</span>
              <span className="ml-auto font-mono text-[10px] text-fg-faint">#{lk.id}</span>
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
        tone === "error" ? "text-danger" : "text-fg-muted",
      )}
    >
      {text}
    </div>
  );
}
