import { useEffect, useRef, useState } from "react";
import type { DTO } from "~/api/client";
import { useConversation, useStartThread, useStatus } from "~/api/hooks";
import { Markdown } from "~/components/detail/Markdown";
import { ProposalCard } from "~/components/mutations/ProposalCard";
import { cn } from "~/lib/cn";
import { type ChatMessage, useChatStream } from "./useChatStream";

export function ChatPane({ itemId }: { itemId: string }) {
  const status = useStatus();
  const history = useConversation(itemId);
  const startThread = useStartThread();
  const [draft, setDraft] = useState("");
  const [proposals, setProposals] = useState<DTO["ProposalDTO"][]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { messages, streaming, error, send, reset } = useChatStream({
    itemId,
    onProposal: (p) => setProposals((prev) => [...prev.filter((x) => x.id !== p.id), p]),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: setProposals is stable; we intentionally reset when the viewed item changes.
  useEffect(() => {
    reset();
    setProposals([]);
  }, [itemId, reset]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new chunk / history refresh.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, history.data]);

  const disabled = !status.data?.chat_enabled;

  return (
    <div className="flex h-full flex-col bg-white dark:bg-zinc-950">
      <header className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">Chat</h2>
        {history.data?.conversation && (
          <span className="font-mono text-[10px] text-zinc-400">
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
          className="ml-auto rounded border border-zinc-200 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900 disabled:opacity-50"
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
              // biome-ignore lint/suspicious/noArrayIndexKey: persisted conversation history is append-only and indexed by position — the index is a stable identity here.
              <PersistedMessage key={`h-${m.role}-${i}-${m.content.length}`} message={m} />
            ))}
            {messages.map((m) => (
              <LiveMessage key={m.id} message={m} />
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
              <div className="mt-2 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
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
        className="border-t border-zinc-200 p-2 dark:border-zinc-800"
      >
        <textarea
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
          className="w-full resize-none rounded border border-zinc-200 bg-white p-2 text-sm focus:border-accent focus:outline-none disabled:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:disabled:bg-zinc-900"
        />
        <div className="mt-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-zinc-400">
          <span>{streaming ? "Streaming…" : "Ready"}</span>
        </div>
      </form>
    </div>
  );
}

function PersistedMessage({ message }: { message: DTO["ChatRoleDTO"] }) {
  if (message.role === "system") return null;
  const role = message.role;
  return (
    <div
      className={cn(
        "mb-3 rounded px-3 py-2 text-sm",
        role === "user"
          ? "bg-zinc-100 dark:bg-zinc-900"
          : role === "tool"
            ? "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            : "bg-white dark:bg-zinc-950",
      )}
    >
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
        {role}
        {message.name ? ` · ${message.name}` : ""}
      </div>
      {role === "tool" ? (
        <pre className="whitespace-pre-wrap font-mono text-xs">{message.content}</pre>
      ) : (
        <Markdown source={message.content} />
      )}
    </div>
  );
}

function LiveMessage({ message }: { message: ChatMessage }) {
  return (
    <div
      className={cn(
        "mb-3 rounded px-3 py-2 text-sm",
        message.kind === "user"
          ? "bg-zinc-100 dark:bg-zinc-900"
          : message.kind === "tool"
            ? "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            : "bg-white dark:bg-zinc-950",
      )}
    >
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
        {message.kind}
        {message.kind === "tool" ? ` · ${message.name}` : ""}
        {message.kind === "assistant" && message.streaming ? " · streaming" : ""}
      </div>
      {message.kind === "tool" ? (
        <pre className="whitespace-pre-wrap font-mono text-xs">{message.text}</pre>
      ) : (
        <Markdown source={message.text || (message.kind === "assistant" ? "…" : "")} />
      )}
    </div>
  );
}

function CenterMessage({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-sm text-zinc-500">
      {text}
    </div>
  );
}
