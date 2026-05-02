import { Clock, ExternalLink, GitBranch, Tag, User, UserX } from "lucide-react";
import Link from "next/link";
import { canonicalIntentsFor, isItemKind, isItemState, type TransitionIntent } from "@/core/types";
import { formatKind, formatRelative } from "@/lib/format";
import { getProviderSpec } from "@/server/provider-registry";
import { AssigneeEditor } from "@/ui/items/assignee-editor";
import { ChatToggleButton } from "@/ui/items/chat-toggle-button";
import { CommentAvatar } from "@/ui/items/comment-avatar";
import { CommentComposer } from "@/ui/items/comment-composer";
import { CopyIdButton } from "@/ui/items/copy-id-button";
import { DescriptionEditor } from "@/ui/items/description-editor";
import { FreshnessStamp } from "@/ui/items/freshness";
import { PinButton } from "@/ui/items/pin-button";
import { ReactionRow } from "@/ui/items/reaction-row";
import { RecentRecorder } from "@/ui/items/recent-recorder";
import { RefreshItemButton } from "@/ui/items/refresh-item-button";
import { StatePill } from "@/ui/items/state-pill";
import { SuggestActionButton } from "@/ui/items/suggest-action-button";
import { TagsEditor } from "@/ui/items/tags-editor";
import { TransitionActions } from "@/ui/items/transition-actions";
import { Markdown } from "@/ui/markdown/markdown";
import { ScrollArea } from "@/ui/primitives/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/primitives/tooltip";

type Comment = {
  id: string;
  providerCommentId: string;
  author: string | null;
  body: string;
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
  description: string | null;
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
  capabilities: {
    supportedReactions: readonly string[];
    stateEncodingTags: readonly string[];
    pullRequestDiffs: boolean;
  };
  providerHasAvatars: boolean;
  item: DetailItem;
  staleThresholdDays: number | null;
  showHeaderReactions: boolean;
  showCommentReactions: boolean;
}) {
  const spec = providerKind ? getProviderSpec(providerKind) : null;
  const profileFor = (identity: string | null): string | null =>
    identity && spec?.profileUrl ? spec.profileUrl(identity) : null;
  const authorProfileUrl = profileFor(item.author);
  const assigneeProfileUrl = profileFor(item.assignee);
  const transitionIntents = ((): readonly TransitionIntent[] => {
    if (!isItemState(item.state)) return [];
    return spec ? spec.availableIntents(item.state) : canonicalIntentsFor(item.state);
  })();
  return (
    <ScrollArea className="h-full bg-background">
      <RecentRecorder projectSlug={projectSlug} itemNumber={item.itemNumber} />
      <header className="flex flex-col gap-3 border-border border-b p-4">
        {/* Row 1: chips left, utility cluster + primary CTAs right */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground text-xs uppercase tracking-wide">
            {formatKind(item.kind)}
          </span>
          <StatePill state={item.state} />
          <CopyIdButton value={item.providerItemId} />
          <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground/70">
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
              body={item.description}
              commentCount={item.comments.length}
              pullRequestDiffs={capabilities.pullRequestDiffs}
            />
            <ChatToggleButton />
          </div>
        </div>

        {/* Rows 2 + 3: title and meta — meta sits tight under the title (mt-1) */}
        <div className="flex flex-col gap-1">
          <h1 className="font-semibold text-foreground text-lg leading-snug">
            {item.title}
            {item.url ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label="Open in provider"
                    className="ml-1.5 inline-flex size-4 translate-y-[-1px] items-center justify-center align-middle text-muted-foreground hover:text-primary"
                  >
                    <ExternalLink aria-hidden="true" className="size-3.5" />
                  </a>
                </TooltipTrigger>
                <TooltipContent side="top">Open in provider</TooltipContent>
              </Tooltip>
            ) : null}
          </h1>

          {/* inline meta line — icons replace dl labels, missing fields omitted */}
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
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
                <User aria-hidden="true" className="size-3" />
              ) : (
                <UserX aria-hidden="true" className="size-3" />
              )}
              <span className="sr-only">Assignee</span>
              <AssigneeEditor
                projectSlug={projectSlug}
                providerItemId={item.providerItemId}
                currentAssignee={item.assignee}
                profileUrl={assigneeProfileUrl}
              />
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
            <li className="inline-flex items-center gap-1">
              <Tag aria-hidden="true" className="size-3" />
              <span className="sr-only">Labels</span>
              <TagsEditor
                projectSlug={projectSlug}
                providerItemId={item.providerItemId}
                currentTags={item.tags}
                stateEncodingTags={capabilities.stateEncodingTags}
              />
            </li>
          </ul>
        </div>

        {/* Actions and reactions groups — each labelled with a small heading
            so the header reads title-block / actions-block / reactions-block. */}
        <div className="flex flex-col gap-3 border-border border-t pt-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <h3 className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                Actions
              </h3>
              <span className="text-[11px] text-muted-foreground/70 italic">
                will require approval
              </span>
            </div>
            <TransitionActions
              projectSlug={projectSlug}
              providerItemId={item.providerItemId}
              intents={transitionIntents}
            />
          </div>
          {capabilities.supportedReactions.length > 0 && showHeaderReactions ? (
            <div className="flex flex-col gap-1.5">
              <h3 className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
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

      <section className="p-4">
        <DescriptionEditor
          projectSlug={projectSlug}
          providerItemId={item.providerItemId}
          description={item.description}
        />
      </section>

      <section className="flex flex-col gap-3 border-border border-t p-4">
        <h2 className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
          Comments ({item.comments.length})
        </h2>
        {item.comments.length === 0 ? (
          <p className="text-muted-foreground/70 text-sm italic">No comments cached.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {item.comments.map((c) => {
              const commentAuthorProfileUrl = profileFor(c.author);
              return (
                <li key={c.id} className="rounded border border-border p-3">
                  <div className="mb-3 flex items-center justify-between gap-2 text-muted-foreground text-xs">
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
                  <Markdown source={c.body} />
                  {capabilities.supportedReactions.length > 0 && showCommentReactions ? (
                    <div className="mt-2 flex flex-col gap-1.5">
                      <h3 className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
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

      <section className="border-border border-t p-4">
        <CommentComposer projectSlug={projectSlug} providerItemId={item.providerItemId} />
      </section>
    </ScrollArea>
  );
}
