import { useEffect, useRef, useState } from "react";
import type { DTO } from "~/api/client";
import { useConversation, useItem, useStartThread, useStatus } from "~/api/hooks";
import { Markdown } from "~/components/detail/Markdown";
import { ProposalCard } from "~/components/mutations/ProposalCard";
import { cn } from "~/lib/cn";
import { type IssueLinkContext, issueLinkContextFromUrl } from "~/lib/issueLinks";
import { useChatPaneController } from "./ChatPaneContext";
import { type ChatMessage, useChatStream } from "./useChatStream";

export function ChatPane({ itemId }: { itemId: string }) {
  const status = useStatus();
  const history = useConversation(itemId);
  const startThread = useStartThread();
  const item = useItem(itemId);
  const chatController = useChatPaneController();
  const issueLinks = issueLinkContextFromUrl(item.data?.url);
  const [draft, setDraft] = useState("");
  const [proposals, setProposals] = useState<DTO["ProposalDTO"][]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const { messages, streaming, error, send, reset } = useChatStream({
    itemId,
    onProposal: (p) => setProposals((prev) => [...prev.filter((x) => x.id !== p.id), p]),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: setProposals is stable; we intentionally reset when the viewed item changes.
  useEffect(() => {
    reset();
    setProposals([]);
    // Also abort on unmount so navigating away mid-stream doesn't leave
    // the fetch reader + AbortController orphaned on a dead component.
    return reset;
  }, [itemId, reset]);

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
            setProposals([]);
          }}
          disabled={startThread.isPending || disabled}
          className="ml-auto rounded border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted hover:bg-surface-alt disabled:opacity-50"
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
              />
            ))}
            {messages.map((m) => (
              <LiveMessage key={m.id} message={m} issueLinks={issueLinks} />
            ))}
            {proposals.length > 0 && (
              <div className="mt-3 flex flex-col gap-2">
                {proposals.map((p) => (
                  <ProposalCard
                    key={p.id}
                    proposal={p}
                    onResolved={() => setProposals((prev) => prev.filter((x) => x.id !== p.id))}
                  />
                ))}
              </div>
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
            Ask the agent to comment, transition, or rewrite — changes appear here as yellow cards
            to confirm.
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
}: {
  message: DTO["ChatRoleDTO"];
  issueLinks: IssueLinkContext;
}) {
  if (message.role === "system") return null;
  const role = message.role;
  // Assistant turns with no text (tool-dispatch rounds, or a rare empty reply)
  // render as a blank "No description." card. The following `tool` rows already
  // show what was called, so skip these instead of showing a misleading card.
  if (role === "assistant" && !message.content.trim()) return null;
  return (
    <div
      className={cn(
        "mb-3 rounded px-3 py-2 text-sm",
        role === "user"
          ? "bg-surface-alt text-fg"
          : role === "tool"
            ? "bg-warning-bg text-warning-fg"
            : "bg-surface text-fg",
      )}
    >
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
        {role}
        {message.name ? ` · ${message.name}` : ""}
      </div>
      {role === "tool" ? (
        <pre className="whitespace-pre-wrap font-mono text-xs">{message.content}</pre>
      ) : (
        <Markdown source={message.content} issueLinks={issueLinks} />
      )}
    </div>
  );
}

function LiveMessage({
  message,
  issueLinks,
}: {
  message: ChatMessage;
  issueLinks: IssueLinkContext;
}) {
  return (
    <div
      className={cn(
        "mb-3 rounded px-3 py-2 text-sm",
        message.kind === "user"
          ? "bg-surface-alt text-fg"
          : message.kind === "tool"
            ? "bg-warning-bg text-warning-fg"
            : "bg-surface text-fg",
      )}
    >
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
        {message.kind}
        {message.kind === "tool" ? ` · ${message.name}` : ""}
        {message.kind === "assistant" && message.streaming ? " · streaming" : ""}
      </div>
      {message.kind === "tool" ? (
        <pre className="whitespace-pre-wrap font-mono text-xs">{message.text}</pre>
      ) : (
        <Markdown
          source={message.text || (message.kind === "assistant" ? "…" : "")}
          issueLinks={issueLinks}
        />
      )}
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
