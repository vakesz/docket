import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DTO } from "~/api/client";
import {
  useConversation,
  useItem,
  usePendingQuestion,
  useStartThread,
  useStatus,
} from "~/api/hooks";
import { Notice } from "~/components/common/Notice";
import { Markdown } from "~/components/detail/Markdown";
import { ProposalCard } from "~/components/mutations/ProposalCard";
import { useLocalProposals } from "~/components/mutations/useLocalProposals";
import { cn } from "~/lib/cn";
import { metaLabelClass, metaLabelFaintClass, microCapsButtonClass } from "~/lib/formClasses";
import { type IssueLinkContext, issueLinkContextFromUrl } from "~/lib/issueLinks";
import { type ToolDisplayMode, useToolDisplayMode } from "~/lib/uiPrefs";
import { useChatPaneController } from "./ChatPaneContext";
import { QuestionCard } from "./QuestionCard";
import { type ChatMessage, useChatStream } from "./useChatStream";

export function ChatPane({ itemId }: { itemId: string }) {
  const status = useStatus();
  const history = useConversation(itemId);
  const pendingQuestionQuery = usePendingQuestion(itemId);
  const startThread = useStartThread();
  const item = useItem(itemId);
  const chatController = useChatPaneController();
  const issueLinks = issueLinkContextFromUrl(item.data?.url);
  const [draft, setDraft] = useState("");
  const {
    proposals,
    push: pushProposal,
    dismiss: dismissProposal,
    reset: resetProposals,
  } = useLocalProposals();
  const [pendingQuestion, setPendingQuestion] = useState<DTO["QuestionDTO"] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // Tracks whether the user is "stuck to the bottom". Flips to false the moment
  // they scroll up; flips back to true when they reach the bottom again. Stored
  // as a ref so the scroll listener and the autoscroll effect can cooperate
  // without re-rendering on every scroll event.
  const stickToBottomRef = useRef(true);
  const autoscrollFrameRef = useRef<number | null>(null);

  const { messages, streaming, error, send, answer, reset } = useChatStream({
    itemId,
    onProposal: pushProposal,
    onQuestion: (q) => setPendingQuestion(q),
    onQuestionResolved: (qid) => setPendingQuestion((prev) => (prev?.id === qid ? null : prev)),
  });
  const [toolDisplayMode] = useToolDisplayMode();

  // Hydrate pending-question state from the server on mount / item switch so a
  // page reload mid-question still shows the card.
  useEffect(() => {
    if (pendingQuestionQuery.data === undefined) return;
    setPendingQuestion(pendingQuestionQuery.data ?? null);
  }, [pendingQuestionQuery.data]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: itemId is the trigger — body only calls stable callbacks, so biome flags it as extra, but losing it means we never reset on item switch.
  useEffect(() => {
    reset();
    resetProposals();
    setPendingQuestion(null);
    // Also abort on unmount so navigating away mid-stream doesn't leave
    // the fetch reader + AbortController orphaned on a dead component.
    return reset;
  }, [itemId, reset, resetProposals]);

  // Auto-scroll only when the user is already near the bottom. A `scroll`
  // listener flips `stickToBottomRef` based on distance-from-bottom, so a
  // user who has scrolled up to read earlier messages isn't yanked back when
  // a new chunk lands. The ResizeObserver below drives the actual scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance < 64;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Coalesce auto-scrolls into a single rAF tick. During streaming the
  // SSE feed produces many message updates per second; calling scrollTo
  // smoothly per chunk causes the in-flight animation to cancel and
  // restart against an ever-growing scrollHeight, which reads as flicker.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the trigger — the effect re-runs whenever the scrollable content can have grown, but doesn't read them inside.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!stickToBottomRef.current) return;
    if (autoscrollFrameRef.current !== null) return;
    autoscrollFrameRef.current = requestAnimationFrame(() => {
      autoscrollFrameRef.current = null;
      const node = scrollRef.current;
      if (!node) return;
      if (!stickToBottomRef.current) return;
      // Instant during streaming so rapid chunk arrivals don't fight a
      // smooth animation; smooth otherwise (history first paint, item switch).
      node.scrollTo({
        top: node.scrollHeight,
        behavior: streaming ? "auto" : "smooth",
      });
    });
    return () => {
      if (autoscrollFrameRef.current !== null) {
        cancelAnimationFrame(autoscrollFrameRef.current);
        autoscrollFrameRef.current = null;
      }
    };
  }, [messages, history.data, proposals.length, pendingQuestion, streaming]);

  // Drain any seeded draft from the chat controller (e.g. "Refine in chat" on
  // a suggestion). Only seed when this pane is the active receiver — opening
  // the chat is the caller's responsibility — and clear immediately so the
  // same seed can't replay on re-mount or item switch.
  useEffect(() => {
    if (!chatController.pendingSeed) return;
    setDraft(chatController.pendingSeed);
    chatController.clearSeed();
    // Defer focus so the textarea is mounted and visible by the time we ask
    // for it (the parent route only renders ChatPane when `open` is true).
    queueMicrotask(() => {
      const el = promptRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }, [chatController.pendingSeed, chatController.clearSeed]);

  const disabled = !status.data?.chat_enabled;

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-fg-muted">Chat</h2>
        {history.data?.conversation && (
          <span className="font-mono text-[10px] text-fg-faint">
            tokens {history.data.conversation.tokens_in + history.data.conversation.tokens_out} · $
            {(history.data.conversation.cost_cents / 100).toFixed(3)}
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            startThread.mutate(itemId);
            reset();
            resetProposals();
          }}
          disabled={startThread.isPending || disabled}
          className={cn("ml-auto disabled:opacity-50", microCapsButtonClass)}
        >
          New thread
        </button>
        <button
          type="button"
          onClick={() => chatController.setOpen(false)}
          title="Close chat"
          aria-label="Close chat"
          className={microCapsButtonClass}
        >
          Close
        </button>
      </header>

      <div ref={scrollRef} className="relative flex-1 overflow-auto px-3 py-3">
        {disabled ? (
          <CenterMessage text="Chat is disabled — configure Azure OpenAI in Settings." />
        ) : (
          <>
            {history.data?.messages.map((m, i) => (
              <PersistedMessage
                // biome-ignore lint/suspicious/noArrayIndexKey: persisted conversation history is append-only and indexed by position — the index is a stable identity here.
                key={`h-${m.role}-${i}`}
                message={m}
                issueLinks={issueLinks}
                toolDisplayMode={toolDisplayMode}
              />
            ))}
            {messages.map((m) => (
              <LiveMessage
                key={m.id}
                message={m}
                issueLinks={issueLinks}
                toolDisplayMode={toolDisplayMode}
              />
            ))}
            {error && (
              <Notice tone="error" title="Chat error" className="mt-2">
                {error}
              </Notice>
            )}
            {(proposals.length > 0 || pendingQuestion) && (
              // Sticky footer inside the scroll container so streaming chunks
              // can't shove the action card off-screen while the user is
              // reading the diff. Sits above the input form, scrolls with
              // content only when there's not enough room.
              <div className="sticky bottom-0 -mx-3 mt-3 border-t border-border bg-bg/95 px-3 pb-1 pt-2 backdrop-blur-sm">
                {proposals.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {proposals.map((p) => (
                      <ProposalCard
                        key={p.id}
                        proposal={p}
                        onResolved={() => dismissProposal(p.id)}
                      />
                    ))}
                  </div>
                )}
                {pendingQuestion && (
                  <div className={proposals.length > 0 ? "mt-2" : undefined}>
                    <QuestionCard
                      question={pendingQuestion}
                      disabled={streaming}
                      onSubmit={(answers) => {
                        const id = pendingQuestion.id;
                        // Drop the card now so it doesn't sit pinned at the
                        // bottom while the resume turn streams tool calls
                        // above it. A new ask_user during the resume re-sets
                        // pendingQuestion via the SSE `question` event with a
                        // fresh id.
                        setPendingQuestion(null);
                        void answer(id, answers);
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled && draft.trim()) {
            void send(draft);
            setDraft("");
          }
        }}
        className="border-t border-border p-2"
      >
        {!disabled && (
          <p className="mb-1 text-[10px] text-fg-faint">
            {pendingQuestion
              ? "Pick from the card above — or type free text and it'll be sent as your answer."
              : "Ask the agent to comment, transition, or rewrite — changes appear here as yellow cards to confirm."}
          </p>
        )}
        <textarea
          ref={promptRef}
          value={draft}
          disabled={disabled || streaming}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!disabled && draft.trim()) {
                void send(draft);
                setDraft("");
              }
            }
          }}
          rows={3}
          placeholder={disabled ? "Chat disabled" : "Ask the agent… (⏎ to send, ⇧⏎ for newline)"}
          className="w-full resize-none rounded border border-border bg-bg p-2 text-sm text-fg focus:border-accent focus:outline-none disabled:bg-surface-alt"
        />
        <div className={cn("mt-1 flex items-center justify-between", metaLabelFaintClass)}>
          <span>{streaming ? "Streaming…" : "Ready"}</span>
        </div>
      </form>
    </div>
  );
}

function PersistedMessage({
  message,
  issueLinks,
  toolDisplayMode,
}: {
  message: DTO["ChatRoleDTO"];
  issueLinks: IssueLinkContext;
  toolDisplayMode: ToolDisplayMode;
}) {
  if (message.role === "system") return null;
  const role = message.role;
  // Assistant turns with no text (tool-dispatch rounds, or a rare empty reply)
  // render as a blank "No description." card. The following `tool` rows already
  // show what was called, so skip these instead of showing a misleading card.
  if (role === "assistant" && !message.content.trim()) return null;
  if (role === "tool") {
    return (
      <ToolMessage name={message.name ?? null} content={message.content} mode={toolDisplayMode} />
    );
  }
  return (
    <div
      className={cn(
        "mb-3 rounded px-3 py-2 text-sm",
        role === "user" ? "bg-surface-alt text-fg" : "bg-surface text-fg",
      )}
    >
      <div className={cn("mb-1", metaLabelClass)}>
        {role}
        {message.name ? ` · ${message.name}` : ""}
      </div>
      <Markdown source={message.content} issueLinks={issueLinks} />
    </div>
  );
}

function LiveMessage({
  message,
  issueLinks,
  toolDisplayMode,
}: {
  message: ChatMessage;
  issueLinks: IssueLinkContext;
  toolDisplayMode: ToolDisplayMode;
}) {
  if (message.kind === "tool_call") {
    if (toolDisplayMode === "hide") return null;
    return (
      <div className="mb-3 rounded border border-dashed border-border px-3 py-1.5 font-mono text-xs text-fg-muted">
        → calling {message.names}
      </div>
    );
  }
  if (message.kind === "tool") {
    return <ToolMessage name={message.name} content={message.text} mode={toolDisplayMode} />;
  }
  return (
    <div
      className={cn(
        "mb-3 rounded px-3 py-2 text-sm",
        message.kind === "user" ? "bg-surface-alt text-fg" : "bg-surface text-fg",
      )}
    >
      <div className={cn("mb-1", metaLabelClass)}>
        {message.kind}
        {message.kind === "assistant" && message.streaming ? " · streaming" : ""}
      </div>
      <Markdown
        source={message.text || (message.kind === "assistant" ? "…" : "")}
        issueLinks={issueLinks}
      />
    </div>
  );
}

function ToolMessage({
  name,
  content,
  mode,
}: {
  name: string | null;
  content: string;
  mode: ToolDisplayMode;
}) {
  // The mode controls *initial* expansion only. Once the user clicks the
  // header, that message owns its open state and ignores later mode changes,
  // so toggling the setting won't snap-collapse a result they just opened.
  const [open, setOpen] = useState(mode === "show");

  if (mode === "hide") return null;

  const label = name ? `tool · ${name}` : "tool";
  const firstLine = content.split("\n", 1)[0]?.trim() ?? "";
  const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;

  return (
    <div className="mb-3 overflow-hidden rounded bg-warning-bg text-warning-fg">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-warning-bg/70"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className={metaLabelClass}>{label}</span>
        {!open && preview && (
          <span className="truncate font-mono text-[11px] text-fg-faint">{preview}</span>
        )}
      </button>
      {open && <pre className="whitespace-pre-wrap px-3 pb-2 font-mono text-xs">{content}</pre>}
    </div>
  );
}

function CenterMessage({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-sm text-fg-faint">
      {text}
    </div>
  );
}
