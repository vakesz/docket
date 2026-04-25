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
import { Markdown } from "~/components/detail/Markdown";
import { ProposalCard } from "~/components/mutations/ProposalCard";
import { useLocalProposals } from "~/components/mutations/useLocalProposals";
import { cn } from "~/lib/cn";
import { microCapsButtonClass } from "~/lib/formClasses";
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new chunk / history refresh.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, history.data]);

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
      </header>

      <div ref={scrollRef} className="flex-1 overflow-auto px-3 py-3">
        {disabled ? (
          <CenterMessage text="Chat is disabled — configure Azure OpenAI in Settings." />
        ) : (
          <>
            {history.data?.messages.map((m, i) => (
              <PersistedMessage
                // biome-ignore lint/suspicious/noArrayIndexKey: persisted conversation history is append-only and indexed by position — the index is a stable identity here.
                key={`h-${m.role}-${i}-${m.content.length}`}
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
            {proposals.length > 0 && (
              <div className="mt-3 flex flex-col gap-2">
                {proposals.map((p) => (
                  <ProposalCard key={p.id} proposal={p} onResolved={() => dismissProposal(p.id)} />
                ))}
              </div>
            )}
            {pendingQuestion && (
              <QuestionCard
                question={pendingQuestion}
                disabled={streaming}
                onSubmit={(answers) => {
                  void answer(pendingQuestion.id, answers);
                }}
              />
            )}
            {error && (
              <div className="mt-2 rounded border border-danger bg-danger-bg p-2 text-xs text-danger-fg">
                {error}
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
        <div className="mt-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-fg-faint">
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
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
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
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
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
        <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
          {label}
        </span>
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
