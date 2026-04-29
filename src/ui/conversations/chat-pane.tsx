"use client";

import { Textarea } from "@headlessui/react";
import { Send, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { metaLabelFaintClass, microCapsButtonClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { type ToolDisplayMode, useToolDisplayMode } from "@/lib/ui-prefs";
import { cn } from "@/lib/utils";
import { Bubble } from "@/ui/conversations/bubble";
import { useChatPaneController } from "@/ui/conversations/chat-pane-context";
import type { SettledRound } from "@/ui/conversations/chat-stream";
import { LlmSwitcher } from "@/ui/conversations/llm-switcher";
import { QuestionCard } from "@/ui/conversations/question-card";
import { ToolCallProgress, ToolCallRow } from "@/ui/conversations/tool-call-row";
import { buildRenderUnits, type PersistedMessage } from "@/ui/conversations/transcript";
import { useChatStream } from "@/ui/conversations/use-chat-stream";
import { extractSeedKind } from "@/ui/items/suggest-seeds";
import { ProposalCard } from "@/ui/proposals/proposal-card";

/**
 * Right pane of the workspace: per-item chat. Reuses the persisted
 * transcript from `conversations.get` for history and overlays the live
 * streaming turn from `useChatStream` on top. The two collapse into one
 * list once the SSE stream completes and tRPC re-fetches.
 *
 * Mounted from `ChatRail` (which derives `itemId` from the URL); this
 * component itself is item-scoped so unmounting on item switch resets
 * stream + question state cleanly.
 *
 * Staged proposals render inline as `ProposalCard`s in a sticky region at
 * the bottom of the scroll area — the user reviews them without leaving
 * the chat (no modal) and can keep typing while multiple cards stack.
 */
export function ChatPane({ projectId, itemId }: { projectId: string; itemId: string }) {
  const utils = trpc.useUtils();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const autoscrollFrameRef = useRef<number | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  // Reentrancy guard for "New thread" — keeps the button visually enabled
  // (no disabled flicker on slow create) while still preventing a stray
  // double-click from creating two threads.
  const startingThreadRef = useRef(false);

  const { streaming, proposalIds, dismissProposal, drainStream, resetStream, stopStream } =
    useChatStream();
  const [toolDisplayMode] = useToolDisplayMode();
  const { pendingSeed, claimSeed } = useChatPaneController();

  const list = trpc.conversations.list.useQuery(
    { projectId, itemId, limit: 20, archived: false },
    { staleTime: 5_000 },
  );
  const fallbackId = useMemo(() => list.data?.[0]?.id ?? null, [list.data]);
  const conversationId = activeId ?? fallbackId;

  const detail = trpc.conversations.get.useQuery(
    { projectId, conversationId: conversationId ?? "" },
    { enabled: conversationId !== null, staleTime: 5_000 },
  );

  const create = trpc.conversations.create.useMutation();
  const archive = trpc.conversations.archive.useMutation({
    onSuccess: async () => {
      await utils.conversations.list.invalidate({ projectId, itemId });
      setActiveId(null);
      resetStream();
    },
  });
  const settings = trpc.settings.list.useQuery();
  const sendOnEnter = useMemo(() => {
    const row = settings.data?.find((r) => r.key === "chat.send-on-enter");
    return row ? Boolean(row.value) : true;
  }, [settings.data]);

  const messages = (detail.data?.messages ?? []) as PersistedMessage[];
  const renderUnits = useMemo(() => buildRenderUnits(messages), [messages]);
  const inFlight = !streaming.done;
  const conversation = detail.data ?? null;

  // Suppress `pendingUserMessage` once its persisted twin has landed in
  // `messages`. Without this we'd render the same user bubble twice for
  // the window between the initial detail.useQuery refetch (which the
  // server has already populated via `appendMessage(role: "user")`) and
  // the post-stream invalidate that finally clears pendingUserMessage in
  // state. Most visible on the "Suggest next action" path because that
  // creates a fresh conversation and forces detail to refetch from
  // scratch mid-stream.
  const hasStreamingActivity =
    streaming.pendingUserMessage !== null ||
    streaming.text.length > 0 ||
    streaming.toolCalls.length > 0 ||
    streaming.settledRounds.length > 0;
  const showPendingUserMessage = useMemo(() => {
    const pending = streaming.pendingUserMessage;
    if (pending === null) return false;
    const target = pending.trim();
    if (!target) return false;
    return !messages.some((m) => m.role === "user" && m.content.trim() === target);
  }, [streaming.pendingUserMessage, messages]);

  // Reset stream + draft on item switch — closures inside the hook are bound
  // to (projectId, itemId, conversationId) for one turn, so a stale stream
  // can't bleed across items.
  // biome-ignore lint/correctness/useExhaustiveDependencies: itemId is the trigger; resetStream is stable.
  useEffect(() => {
    resetStream();
    setActiveId(null);
    setDraft("");
  }, [itemId]);

  // Stick-to-bottom scroll: flip the ref to false the moment the user
  // scrolls up, and back to true once they're within 64px of the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance < 64;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Coalesce auto-scrolls into a single rAF tick. SSE chunk arrival fires
  // many state updates per second; a smooth scroll per chunk would cancel
  // and restart against an ever-growing scrollHeight, reading as flicker.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the trigger; the body only reads scrollRef + stickToBottomRef.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    if (autoscrollFrameRef.current !== null) return;
    autoscrollFrameRef.current = requestAnimationFrame(() => {
      autoscrollFrameRef.current = null;
      const node = scrollRef.current;
      if (!node || !stickToBottomRef.current) return;
      node.scrollTo({
        top: node.scrollHeight,
        behavior: streaming.done ? "smooth" : "auto",
      });
    });
    return () => {
      if (autoscrollFrameRef.current !== null) {
        cancelAnimationFrame(autoscrollFrameRef.current);
        autoscrollFrameRef.current = null;
      }
    };
  }, [
    messages.length,
    streaming.pendingUserMessage,
    streaming.settledRounds.length,
    streaming.text,
    streaming.toolCalls.length,
    streaming.question,
    streaming.done,
  ]);

  const submit = async (raw?: string) => {
    const body = (raw ?? draft).trim();
    if (!body || inFlight) return;
    let id = conversationId;
    if (!id) {
      const conv = await create.mutateAsync({ projectId, itemId });
      id = conv.id;
      setActiveId(conv.id);
    }
    setDraft("");
    await drainStream({ projectId, itemId, conversationId: id, content: body });
  };

  // Consume a queued "Suggest next action" seed: open a fresh thread and
  // submit it as a normal user message. We start a *new* thread so the
  // suggestion isn't appended to whatever the user was last asking about
  // for this item — distinct entry point, distinct conversation.
  //
  // `claimSeed()` is ref-backed and atomic: when the layout has two
  // ChatPane instances mounted simultaneously (desktop Group + mobile
  // Dialog can race on viewport transitions), only the first effect to
  // call it gets the string back. The loser bails without firing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingSeed is the trigger; the rest is captured.
  useEffect(() => {
    if (!pendingSeed) return;
    if (inFlight) return;
    const seed = claimSeed();
    if (seed === null) return;
    void (async () => {
      const conv = await create.mutateAsync({ projectId, itemId });
      setActiveId(conv.id);
      resetStream();
      await drainStream({
        projectId,
        itemId,
        conversationId: conv.id,
        content: seed,
      });
    })();
  }, [pendingSeed, inFlight]);

  const startNewThread = async () => {
    if (startingThreadRef.current) return;
    startingThreadRef.current = true;
    try {
      // Snapshot whether we were streaming BEFORE we touch any state. The
      // call to resetStream() below aborts the in-flight fetch
      // synchronously, which propagates through Next.js's req.signal into
      // the OpenAI SDK and stops upstream token generation on the next
      // event-loop tick. Doing this *before* any await guarantees the LLM
      // is cut off immediately even if the create / invalidate calls below
      // take a moment.
      //
      // resetStream also clears `proposalIds`, so any pending or rejected
      // proposal cards still pinned at the bottom of the prior thread
      // disappear — the new thread starts with a clean scroll region.
      const wasInFlight = inFlight;
      const priorConvId = conversationId;
      resetStream();
      // If a stream was running, the agent loop's persistAssistantTurn
      // catch handler will have flushed any partial output. Refetch so the
      // prior thread shows what it managed to produce.
      if (wasInFlight && priorConvId) {
        await Promise.all([
          utils.conversations.list.invalidate({ projectId, itemId }),
          utils.conversations.get.invalidate({ projectId, conversationId: priorConvId }),
        ]);
      }
      const conv = await create.mutateAsync({ projectId, itemId });
      setActiveId(conv.id);
      await utils.conversations.list.invalidate({ projectId, itemId });
      promptRef.current?.focus();
    } finally {
      startingThreadRef.current = false;
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Chat
        </h2>
        {conversation && (
          <span className="font-mono text-[10px] text-muted-foreground-faint">
            tokens {conversation.tokensIn + conversation.tokensOut} · $
            {(conversation.costCents / 100).toFixed(3)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void startNewThread()}
            className={microCapsButtonClass}
            title={
              inFlight
                ? "Stop this thread, dismiss any open proposals, and start a new one"
                : "Dismiss any open proposals and start a new thread"
            }
          >
            New thread
          </button>
          {conversationId && (
            <button
              type="button"
              onClick={() => archive.mutate({ projectId, conversationId })}
              disabled={archive.isPending || inFlight}
              className={cn(microCapsButtonClass, "disabled:opacity-50")}
              title="Archive this conversation"
            >
              Archive
            </button>
          )}
        </div>
      </header>

      <div ref={scrollRef} className="relative flex-1 overflow-auto px-3 py-3">
        {!conversationId && messages.length === 0 && !hasStreamingActivity ? (
          <p className="text-sm italic text-muted-foreground-faint">
            No conversation yet. Send a message to start one.
          </p>
        ) : detail.isPending && messages.length === 0 && !hasStreamingActivity ? (
          <p className="text-sm italic text-muted-foreground-faint">Loading messages…</p>
        ) : (
          <>
            {renderUnits.map((unit) => {
              if (unit.kind === "text") {
                return (
                  <Bubble
                    key={unit.key}
                    messageRole={unit.role}
                    text={unit.content}
                    seedKind={unit.seedKind}
                  />
                );
              }
              return (
                <ToolCallRow
                  key={unit.key}
                  name={unit.name}
                  args={unit.arguments}
                  result={unit.result}
                  ok={unit.ok}
                  mode={toolDisplayMode}
                />
              );
            })}
            {showPendingUserMessage && streaming.pendingUserMessage && (
              <Bubble
                messageRole="user"
                text={streaming.pendingUserMessage}
                seedKind={extractSeedKind(streaming.pendingUserMessage)}
              />
            )}
            {streaming.settledRounds.map((round, idx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: settledRounds is append-only during one stream; index is stable for the lifetime of the snapshot.
              <SettledRoundView key={`settled:${idx}`} round={round} mode={toolDisplayMode} />
            ))}
            {inFlight && streaming.text && <Bubble messageRole="assistant" text={streaming.text} />}
            {streaming.toolCalls.length > 0 && (
              <ToolCallProgress
                toolCalls={streaming.toolCalls}
                mode={toolDisplayMode}
                streaming={inFlight}
              />
            )}
            {inFlight && !streaming.question && <ThinkingDots />}
            {streaming.guardrailNotices.length > 0 && (
              <div className="mt-1 flex flex-col gap-1">
                {streaming.guardrailNotices.map((notice, idx) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: notices are append-only within one stream.
                    key={`guardrail:${idx}`}
                    className={
                      notice.blocked
                        ? "rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                        : "rounded border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-warning"
                    }
                  >
                    <span className="font-medium uppercase tracking-wide">
                      {notice.blocked ? "Blocked" : "Flagged"} · {notice.stage.replace("_", " ")}
                    </span>
                    <span className="ml-2">{notice.reason}</span>
                  </div>
                ))}
              </div>
            )}
            {streaming.error && (
              <div className="mt-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {streaming.error}
              </div>
            )}
            {((!inFlight && proposalIds.length > 0) || streaming.question) && (
              <div className="sticky bottom-0 -mx-3 mt-3 flex flex-col gap-2 border-t border-border bg-background/95 px-3 pb-1 pt-2 backdrop-blur-sm">
                {!inFlight &&
                  proposalIds.map((id) => (
                    <ProposalCard
                      key={id}
                      projectId={projectId}
                      proposalId={id}
                      onDismiss={() => dismissProposal(id)}
                    />
                  ))}
                {streaming.question && (
                  <QuestionCard
                    question={streaming.question}
                    disabled={inFlight && !streaming.question}
                    onSubmit={(answer) => void submit(answer)}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="border-t border-border p-2"
      >
        <p className="mb-1 text-[10px] text-muted-foreground-faint">
          {streaming.question
            ? "Pick from the card above — or type free text and it'll be sent as your answer."
            : "Ask the agent to comment, transition, or rewrite — changes appear as cards to confirm."}
        </p>
        <Textarea
          ref={promptRef}
          value={draft}
          disabled={inFlight}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Honor the user pref: if "send on Enter" is on, plain Enter
            // sends and Shift+Enter inserts a newline; flipped otherwise.
            const enter = e.key === "Enter";
            if (!enter) return;
            const wantSend = sendOnEnter ? !e.shiftKey : e.shiftKey;
            if (wantSend) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={3}
          placeholder={
            sendOnEnter
              ? "Ask the agent… (⏎ to send, ⇧⏎ for newline)"
              : "Ask the agent… (⇧⏎ to send, ⏎ for newline)"
          }
          className="w-full resize-none rounded border border-border bg-background p-2 text-sm text-foreground focus:border-primary focus:outline-none disabled:bg-muted"
        />
        <div className={cn("mt-1 flex items-center justify-between gap-2", metaLabelFaintClass)}>
          <LlmSwitcher
            projectId={projectId}
            conversationId={conversationId}
            currentOverrideId={detail.data?.llmProviderIdOverride ?? null}
          />
          <div className="flex items-center gap-2">
            {create.error && <span className="text-destructive">{create.error.message}</span>}
            {inFlight ? (
              <button
                type="button"
                onClick={() => {
                  if (!conversationId) return;
                  void stopStream({ projectId, itemId, conversationId });
                }}
                className={cn(
                  microCapsButtonClass,
                  "border border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive",
                )}
                title="Stop generation"
              >
                <Square className="h-3 w-3" aria-hidden />
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!draft.trim()}
                className={cn(microCapsButtonClass, "disabled:opacity-50")}
                title="Send message"
              >
                <Send className="h-3 w-3" aria-hidden />
                Send
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

/**
 * One settled inner round of a multi-round turn: the assistant's text
 * bubble plus the tool calls it dispatched, rendered the same way the
 * persisted view will render them once the post-stream `invalidate`
 * brings the official rows in. Keeping this layout matched to
 * `buildRenderUnits` is the whole point — the live → persisted swap is
 * visually a no-op.
 */
function ThinkingDots() {
  return (
    <output className="mb-3 flex items-center gap-1 px-3 py-2" aria-label="Thinking">
      <span
        className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground-faint"
        style={{ animationDelay: "0ms" }}
      />
      <span
        className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground-faint"
        style={{ animationDelay: "150ms" }}
      />
      <span
        className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground-faint"
        style={{ animationDelay: "300ms" }}
      />
    </output>
  );
}

function SettledRoundView({ round, mode }: { round: SettledRound; mode: ToolDisplayMode }) {
  return (
    <>
      {round.text.length > 0 && <Bubble messageRole="assistant" text={round.text} />}
      {round.toolCalls.map((tc) => (
        <ToolCallRow
          key={tc.callId}
          name={tc.name}
          args={tc.arguments}
          result=""
          ok={tc.ok}
          mode={mode}
        />
      ))}
    </>
  );
}
