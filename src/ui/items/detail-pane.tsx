import { Clock, ExternalLink, GitBranch, Tag, User, UserX } from "lucide-react";
import Link from "next/link";
import { type ItemState, isItemKind, isItemState } from "@/core/types";
import { displayTag, formatKind, formatRelative, providerProfileUrl } from "@/lib/format";
import { ChatToggleButton } from "@/ui/items/chat-toggle-button";
import { CommentAvatar } from "@/ui/items/comment-avatar";
import { CommentComposer } from "@/ui/items/comment-composer";
import { CopyIdButton } from "@/ui/items/copy-id-button";
import { FreshnessStamp } from "@/ui/items/freshness";
import { PinButton } from "@/ui/items/pin-button";
import { ReactionRow } from "@/ui/items/reaction-row";
import { RecentRecorder } from "@/ui/items/recent-recorder";
import { RefreshItemButton } from "@/ui/items/refresh-item-button";
import { StatePill } from "@/ui/items/state-pill";
import { SuggestActionButton } from "@/ui/items/suggest-action-button";
import { TransitionActions } from "@/ui/items/transition-actions";
import { Markdown } from "@/ui/markdown/markdown";

type Comment = {
  id: string;
  providerCommentId: string;
  author: string | null;
  bodyMd: string;
  reactions: unknown;
  createdAt: Date;
};

type DetailItem = {
  id: string;
  providerItemId: string;
  itemNumber: string;
  kind: string;
  title: string;
  state: string;
  assignee: string | null;
  author: string | null;
  parentId: string | null;
  parentNumber: string | null;
  tags: string[];
  url: string | null;
  descriptionMd: string | null;
  reactions: unknown;
  createdAt: Date | null;
  updatedAt: Date;
  comments: Comment[];
};

/**
 * Middle pane of the workspace shell: full item detail.
 *
 * Layout order is header → description → comments → new-comment composer,
 * with transition actions sitting inside the header next to pin/refresh.
 * Server component so the initial render carries the full detail without a
 * client round-trip; interactive bits (pin, refresh, transition + comment
 * proposals) are tiny client islands.
 */
export function DetailPane({
  projectSlug,
  providerKind,
  capabilities,
  providerHasAvatars,
  item,
  staleThresholdDays,
  showHeaderReactions,
  showCommentReactions,
}: {
  projectSlug: string;
  providerKind: string | null;
  capabilities: { supportedReactions: readonly string[] };
  providerHasAvatars: boolean;
  item: DetailItem;
  staleThresholdDays: number | null;
  showHeaderReactions: boolean;
  showCommentReactions: boolean;
}) {
  const authorProfileUrl = providerProfileUrl(providerKind, item.author);
  const assigneeProfileUrl = providerProfileUrl(providerKind, item.assignee);
  return (
    <div className="flex h-full flex-col overflow-auto bg-background">
      <RecentRecorder projectSlug={projectSlug} itemNumber={item.itemNumber} />
      <header className="flex flex-col gap-3 border-b border-border p-4">
        {/* Row 1: chips left, utility cluster + primary CTAs right */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            {formatKind(item.kind)}
          </span>
          <StatePill state={item.state} />
          <CopyIdButton value={item.providerItemId} />
          <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground-faint">
            <span className="font-mono text-[10px]">Updated</span>
            <FreshnessStamp updatedAt={item.updatedAt} thresholdDays={staleThresholdDays} />
          </span>
          <div className="flex items-center gap-1">
            <PinButton projectSlug={projectSlug} providerItemId={item.providerItemId} compact />
            <RefreshItemButton projectSlug={projectSlug} itemNumber={item.itemNumber} compact />
          </div>
          <div className="flex items-center gap-2">
            <SuggestActionButton
              kind={isItemKind(item.kind) ? item.kind : null}
              state={isItemState(item.state) ? item.state : null}
              title={item.title}
              bodyMd={item.descriptionMd}
              commentCount={item.comments.length}
            />
            <ChatToggleButton />
          </div>
        </div>

        {/* Rows 2 + 3: title and meta — meta sits tight under the title (mt-1) */}
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold leading-snug text-foreground">{item.title}</h1>

          {/* inline meta line — icons replace dl labels, missing fields omitted */}
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {item.author ? (
              <li className="inline-flex items-center gap-1">
                <User aria-hidden="true" className="size-3" />
                <span className="sr-only">Opened by</span>
                {authorProfileUrl ? (
                  <a
                    href={authorProfileUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-foreground hover:text-primary hover:underline"
                  >
                    {item.author}
                  </a>
                ) : (
                  <span className="text-foreground">{item.author}</span>
                )}
              </li>
            ) : null}
            {item.createdAt ? (
              <li className="inline-flex items-center gap-1">
                <Clock aria-hidden="true" className="size-3" />
                <span className="sr-only">Opened</span>
                <time
                  dateTime={item.createdAt.toISOString()}
                  title={item.createdAt.toLocaleString()}
                >
                  opened {formatRelative(item.createdAt)}
                </time>
              </li>
            ) : null}
            <li className="inline-flex items-center gap-1">
              {item.assignee ? (
                <>
                  <User aria-hidden="true" className="size-3" />
                  <span className="sr-only">Assignee</span>
                  {assigneeProfileUrl ? (
                    <a
                      href={assigneeProfileUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-foreground hover:text-primary hover:underline"
                    >
                      {item.assignee}
                    </a>
                  ) : (
                    <span className="text-foreground">{item.assignee}</span>
                  )}
                </>
              ) : (
                <>
                  <UserX aria-hidden="true" className="size-3" />
                  <span className="italic text-muted-foreground-faint">unassigned</span>
                </>
              )}
            </li>
            {item.parentNumber ? (
              <li className="inline-flex items-center gap-1">
                <GitBranch aria-hidden="true" className="size-3" />
                <span className="sr-only">Parent</span>
                <Link
                  href={`/projects/${projectSlug}/items/${item.parentNumber}`}
                  className="text-primary hover:underline"
                >
                  #{item.parentNumber}
                </Link>
              </li>
            ) : null}
            {item.tags.length > 0 ? (
              <li className="inline-flex items-center gap-1">
                <Tag aria-hidden="true" className="size-3" />
                <span className="sr-only">Labels</span>
                <span className="inline-flex flex-wrap items-center gap-1">
                  {item.tags.map((tag) => (
                    <span
                      key={tag}
                      title={tag}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {displayTag(tag)}
                    </span>
                  ))}
                </span>
              </li>
            ) : null}
            {item.url ? (
              <li className="inline-flex items-center gap-1">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Open in provider
                  <ExternalLink aria-hidden="true" className="size-3" />
                </a>
              </li>
            ) : null}
          </ul>
        </div>

        {/* Actions and reactions groups — each labelled with a small heading
            so the header reads title-block / actions-block / reactions-block. */}
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <h3 className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Actions
              </h3>
              <span className="text-[11px] italic text-muted-foreground-faint">
                will require approval
              </span>
            </div>
            <TransitionActions
              projectSlug={projectSlug}
              providerItemId={item.providerItemId}
              state={item.state as ItemState}
            />
          </div>
          {capabilities.supportedReactions.length > 0 && showHeaderReactions ? (
            <div className="flex flex-col gap-1.5">
              <h3 className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Reactions
              </h3>
              <ReactionRow
                projectSlug={projectSlug}
                providerItemId={item.providerItemId}
                targetKind="item"
                targetId={item.providerItemId}
                reactions={item.reactions}
                supportedReactions={capabilities.supportedReactions}
              />
            </div>
          ) : null}
        </div>
      </header>

      <section className="flex flex-col gap-3 p-4">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Description
        </h2>
        {item.descriptionMd ? (
          <Markdown source={item.descriptionMd} />
        ) : (
          <p className="text-sm italic text-muted-foreground-faint">(no description)</p>
        )}
      </section>

      <section className="flex flex-col gap-3 border-t border-border p-4">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Comments ({item.comments.length})
        </h2>
        {item.comments.length === 0 ? (
          <p className="text-sm italic text-muted-foreground-faint">No comments cached.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {item.comments.map((c) => {
              const commentAuthorProfileUrl = providerProfileUrl(providerKind, c.author);
              return (
                <li key={c.id} className="rounded border border-border p-3">
                  <div className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-2">
                      {c.author ? (
                        <CommentAvatar
                          name={c.author}
                          providerKind={providerKind}
                          providerHasAvatars={providerHasAvatars}
                        />
                      ) : null}
                      {c.author ? (
                        commentAuthorProfileUrl ? (
                          <a
                            href={commentAuthorProfileUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="font-medium text-foreground hover:text-primary hover:underline"
                          >
                            {c.author}
                          </a>
                        ) : (
                          <span className="font-medium text-foreground">{c.author}</span>
                        )
                      ) : (
                        <span className="font-medium text-foreground">(unknown)</span>
                      )}
                    </span>
                    <time
                      dateTime={c.createdAt.toISOString()}
                      title={c.createdAt.toLocaleString()}
                      className="font-mono text-[10px]"
                    >
                      {formatRelative(c.createdAt)}
                    </time>
                  </div>
                  <Markdown source={c.bodyMd} />
                  {capabilities.supportedReactions.length > 0 && showCommentReactions ? (
                    <div className="mt-2 flex flex-col gap-1.5">
                      <h3 className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        Reactions
                      </h3>
                      <ReactionRow
                        projectSlug={projectSlug}
                        providerItemId={item.providerItemId}
                        targetKind="comment"
                        targetId={c.providerCommentId}
                        reactions={c.reactions}
                        supportedReactions={capabilities.supportedReactions}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="border-t border-border p-4">
        <CommentComposer projectSlug={projectSlug} providerItemId={item.providerItemId} />
      </section>
    </div>
  );
}
