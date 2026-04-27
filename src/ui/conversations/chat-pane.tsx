"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { metaLabelClass, metaLabelFaintClass, microCapsButtonClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { type ToolDisplayMode, useToolDisplayMode } from "@/lib/ui-prefs";
import { cn } from "@/lib/utils";
import { LlmSwitcher } from "@/ui/conversations/llm-switcher";
import { QuestionCard } from "@/ui/conversations/question-card";
import { useChatStream } from "@/ui/conversations/use-chat-stream";
import { ProposalDialog } from "@/ui/proposals/proposal-dialog";

type PersistedMessage = {
  id: string;
  role: string;
  content: string;
  toolName: string | null;
};

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
 * TODO(port): render assistant + persisted message bodies as markdown
 * (main uses remark/rehype + highlight.js). For now it's whitespace-pre-
 * wrap which is readable but loses fenced code highlighting and links.
 *
 * TODO(port): main rendered staged proposals as inline cards inside the
 * chat scroll region; T3 still uses the modal `ProposalDialog`. Once
 * Phase 4 ports the diff modal styling, fold ProposalCard into the
 * sticky bottom row alongside the question card.
 */
export function ChatPane({ projectId, itemId }: { projectId: string; itemId: string }) {
  const utils = trpc.useUtils();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const autoscrollFrameRef = useRef<number | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const { streaming, pendingProposalId, setPendingProposalId, drainStream, resetStream } =
    useChatStream();
  const [toolDisplayMode] = useToolDisplayMode();

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
  const inFlight = !streaming.done;
  const conversation = detail.data ?? null;

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

  const startNewThread = async () => {
    if (inFlight) return;
    const conv = await create.mutateAsync({ projectId, itemId });
    setActiveId(conv.id);
    resetStream();
    promptRef.current?.focus();
  };

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-fg-muted">Chat</h2>
        {conversation && (
          <span className="font-mono text-[10px] text-fg-faint">
            tokens {conversation.tokensIn + conversation.tokensOut} · $
            {(conversation.costCents / 100).toFixed(3)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <LlmSwitcher
            projectId={projectId}
            conversationId={conversationId}
            currentOverrideId={detail.data?.llmProviderIdOverride ?? null}
          />
          <button
            type="button"
            onClick={() => void startNewThread()}
            disabled={inFlight || create.isPending}
            className={cn(microCapsButtonClass, "disabled:opacity-50")}
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
        {!conversationId && messages.length === 0 && !streaming.text ? (
          <p className="text-sm italic text-fg-faint">
            No conversation yet. Send a message to start one.
          </p>
        ) : detail.isPending && messages.length === 0 ? (
          <p className="text-sm italic text-fg-faint">Loading messages…</p>
        ) : (
          <>
            {messages.map((m) => (
              <Persisted key={m.id} message={m} mode={toolDisplayMode} />
            ))}
            {inFlight && streaming.text && (
              <Bubble messageRole="assistant" text={streaming.text} streaming />
            )}
            {streaming.toolCalls.length > 0 && (
              <ToolCallProgress
                toolCalls={streaming.toolCalls}
                mode={toolDisplayMode}
                streaming={inFlight}
              />
            )}
            {streaming.error && (
              <div className="mt-2 rounded border border-danger/40 bg-danger-bg px-3 py-2 text-xs text-danger-fg">
                {streaming.error}
              </div>
            )}
            {streaming.question && (
              <div className="sticky bottom-0 -mx-3 mt-3 border-t border-border bg-bg/95 px-3 pb-1 pt-2 backdrop-blur-sm">
                <QuestionCard
                  question={streaming.question}
                  disabled={inFlight && !streaming.question}
                  onSubmit={(answer) => void submit(answer)}
                />
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
        <p className="mb-1 text-[10px] text-fg-faint">
          {streaming.question
            ? "Pick from the card above — or type free text and it'll be sent as your answer."
            : "Ask the agent to comment, transition, or rewrite — changes appear as cards to confirm."}
        </p>
        <textarea
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
            inFlight
              ? "Streaming…"
              : sendOnEnter
                ? "Ask the agent… (⏎ to send, ⇧⏎ for newline)"
                : "Ask the agent… (⇧⏎ to send, ⏎ for newline)"
          }
          className="w-full resize-none rounded border border-border bg-bg p-2 text-sm text-fg focus:border-accent focus:outline-none disabled:bg-surface-alt"
        />
        <div className={cn("mt-1 flex items-center justify-between", metaLabelFaintClass)}>
          <span>{inFlight ? "Streaming…" : "Ready"}</span>
          {create.error && <span className="text-danger-fg">{create.error.message}</span>}
        </div>
      </form>

      <ProposalDialog
        projectId={projectId}
        proposalId={pendingProposalId}
        onClose={() => setPendingProposalId(null)}
      />
    </div>
  );
}

function Persisted({ message, mode }: { message: PersistedMessage; mode: ToolDisplayMode }) {
  if (message.role === "system") return null;
  if (message.role === "tool") {
    return <ToolMessage name={message.toolName} content={message.content} mode={mode} />;
  }
  if (message.role === "assistant" && !message.content.trim()) {
    // Tool-dispatch round with no preamble — the following tool rows already
    // show what was called, so an empty assistant card would just be noise.
    return null;
  }
  return <Bubble messageRole={message.role} text={message.content} />;
}

function Bubble({
  messageRole,
  text,
  streaming = false,
}: {
  messageRole: string;
  text: string;
  streaming?: boolean;
}) {
  const tone = messageRole === "user" ? "bg-surface-alt text-fg" : "bg-surface text-fg";
  return (
    <div className={cn("mb-3 rounded px-3 py-2 text-sm", tone)}>
      <div className={cn("mb-1", metaLabelClass)}>
        {messageRole}
        {streaming ? " · streaming" : ""}
      </div>
      <p className="whitespace-pre-wrap text-fg">{text || (streaming ? "…" : "")}</p>
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
  // Initial open state derives from `mode` once; after the user toggles, the
  // row owns its own open state so flipping the global pref doesn't snap-
  // collapse a result they just expanded.
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

function ToolCallProgress({
  toolCalls,
  mode,
  streaming,
}: {
  toolCalls: { callId: string; name: string; ok: boolean | null }[];
  mode: ToolDisplayMode;
  streaming: boolean;
}) {
  if (mode === "hide") return null;
  if (!streaming && toolCalls.every((tc) => tc.ok !== null)) {
    // Once the turn is done and the persisted transcript catches up,
    // PersistedMessage renders the tool rows. Don't double-show.
    return null;
  }
  return (
    <div className="mb-3 flex flex-col gap-1 rounded border border-dashed border-border px-3 py-1.5 font-mono text-xs text-fg-muted">
      {toolCalls.map((tc) => (
        <div key={tc.callId}>
          {tc.ok === null ? "→" : tc.ok ? "✓" : "✗"} {tc.name}
        </div>
      ))}
    </div>
  );
}
