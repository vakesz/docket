"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { LlmSwitcher } from "@/ui/conversations/llm-switcher";
import { MessageBubble } from "@/ui/conversations/message-bubble";
import { useChatStream } from "@/ui/conversations/use-chat-stream";
import { Button } from "@/ui/primitives/button";
import { ProposalDialog } from "@/ui/proposals/proposal-dialog";

/**
 * Per-item chat panel. Streams the assistant turn over SSE (handled by
 * `useChatStream`) and reconciles with the persisted transcript
 * (`conversations.get`) once the turn closes.
 */
export function ChatPanel({ projectId, itemId }: { projectId: string; itemId: string }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { streaming, pendingProposalId, setPendingProposalId, drainStream } = useChatStream();

  const list = trpc.conversations.list.useQuery(
    { projectId, itemId, limit: 20, archived: false },
    { staleTime: 0 },
  );

  const fallbackId = useMemo(() => list.data?.[0]?.id ?? null, [list.data]);
  const conversationId = activeId ?? fallbackId;

  const detail = trpc.conversations.get.useQuery(
    { projectId, conversationId: conversationId ?? "" },
    { enabled: conversationId !== null, staleTime: 0 },
  );

  const create = trpc.conversations.create.useMutation();

  const messages = detail.data?.messages ?? [];
  const inFlight = !streaming.done;

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when messages or stream advances, even though the body only reads scrollRef.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.length, streaming.text]);

  const submit = async () => {
    const body = draft.trim();
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

  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Chat</h2>
        <LlmSwitcher
          projectId={projectId}
          conversationId={conversationId}
          currentOverrideId={detail.data?.llmProviderIdOverride ?? null}
        />
      </header>
      <div
        ref={scrollRef}
        className="flex max-h-96 min-h-[8rem] flex-col gap-2 overflow-y-auto rounded-md border border-border bg-card p-3"
      >
        {!conversationId ? (
          <p className="text-sm text-muted-foreground italic">
            No conversation yet. Send a message to start one.
          </p>
        ) : detail.isPending ? (
          <p className="text-sm text-muted-foreground italic">Loading messages…</p>
        ) : messages.length === 0 && !streaming.text ? (
          <p className="text-sm text-muted-foreground italic">
            Conversation started. Send your first message.
          </p>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} messageRole={m.role} content={m.content} />)
        )}

        {inFlight && streaming.text && (
          <MessageBubble messageRole="assistant" content={streaming.text} />
        )}
        {streaming.toolCalls.length > 0 && (
          <div className="self-start text-xs text-muted-foreground italic">
            {streaming.toolCalls.map((tc) => (
              <div key={tc.callId}>
                {tc.ok === null ? "→" : tc.ok ? "✓" : "✗"} {tc.name}
              </div>
            ))}
          </div>
        )}
        {streaming.question && (
          <div className="self-stretch rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <div className="mb-1 text-[10px] uppercase tracking-wide opacity-70">
              Assistant question
            </div>
            <div className="whitespace-pre-wrap">{streaming.question.question}</div>
            {streaming.question.options && (
              <ul className="mt-2 list-disc pl-5">
                {streaming.question.options.map((opt) => (
                  <li key={opt}>{opt}</li>
                ))}
              </ul>
            )}
            <div className="mt-1 text-[11px] opacity-70">
              Reply below to answer
              {streaming.question.multiSelect ? " (multiple options allowed)" : ""}.
            </div>
          </div>
        )}
        {streaming.error && (
          <div className="self-stretch text-xs text-destructive">Error: {streaming.error}</div>
        )}
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask the assistant about this item…"
          rows={3}
          className="rounded-md border border-border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          disabled={inFlight}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter to send</span>
          <Button type="submit" size="sm" disabled={inFlight || !draft.trim()}>
            {inFlight ? "Streaming…" : "Send"}
          </Button>
        </div>
      </form>

      {create.error && <p className="text-xs text-destructive">{create.error.message}</p>}

      <ProposalDialog
        projectId={projectId}
        proposalId={pendingProposalId}
        onClose={() => setPendingProposalId(null)}
      />
    </section>
  );
}
