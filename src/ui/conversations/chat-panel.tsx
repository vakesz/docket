"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";

/**
 * Per-item chat panel.
 *
 * Picks the most recently started conversation for `(projectId, itemId)`
 * — or creates one on first send. Phase 5 ships with a stub assistant
 * that just echoes; Phase 6 swaps the agent in without touching this
 * component.
 */
export function ChatPanel({ projectId, itemId }: { projectId: string; itemId: string }) {
  const utils = trpc.useUtils();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const list = trpc.conversations.list.useQuery(
    { projectId, itemId, limit: 20, archived: false },
    { staleTime: 0 },
  );

  // Default to the most recent conversation in the list (if any).
  const fallbackId = useMemo(() => list.data?.[0]?.id ?? null, [list.data]);
  const conversationId = activeId ?? fallbackId;

  const detail = trpc.conversations.get.useQuery(
    { projectId, conversationId: conversationId ?? "" },
    { enabled: conversationId !== null, staleTime: 0 },
  );

  const create = trpc.conversations.create.useMutation();
  const post = trpc.conversations.postMessage.useMutation({
    onSuccess: async (conv) => {
      setActiveId(conv.id);
      setDraft("");
      await Promise.all([
        utils.conversations.list.invalidate({ projectId, itemId }),
        utils.conversations.get.invalidate({ projectId, conversationId: conv.id }),
      ]);
    },
  });

  // Auto-scroll to the bottom when new messages arrive.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, []);

  const submit = async () => {
    const body = draft.trim();
    if (!body || post.isPending) return;
    let id = conversationId;
    if (!id) {
      const conv = await create.mutateAsync({ projectId, itemId });
      id = conv.id;
      setActiveId(conv.id);
    }
    post.mutate({ projectId, conversationId: id, content: body });
  };

  const messages = detail.data?.messages ?? [];

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Chat</h2>
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
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            Conversation started. Send your first message.
          </p>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} role={m.role} content={m.content} />)
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
          disabled={post.isPending}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter to send</span>
          <Button type="submit" size="sm" disabled={post.isPending || !draft.trim()}>
            {post.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
      </form>

      {(post.error || create.error) && (
        <p className="text-xs text-destructive">{(post.error ?? create.error)?.message}</p>
      )}
    </section>
  );
}

function MessageBubble({ role, content }: { role: string; content: string }) {
  const tone =
    role === "user"
      ? "self-end bg-primary/10 text-primary-foreground"
      : role === "assistant"
        ? "self-start bg-muted"
        : "self-stretch border border-dashed border-border bg-muted/40 text-muted-foreground";
  const label =
    role === "user"
      ? "You"
      : role === "assistant"
        ? "Assistant"
        : role === "system"
          ? "System"
          : role;
  return (
    <div className={`max-w-[85%] rounded-md px-3 py-2 text-sm ${tone}`}>
      <div className="mb-1 text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="whitespace-pre-wrap break-words text-sm text-foreground">{content}</div>
    </div>
  );
}
