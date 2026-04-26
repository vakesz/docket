"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { LlmSwitcher } from "@/ui/conversations/llm-switcher";
import { Button } from "@/ui/primitives/button";
import { ProposalDialog } from "@/ui/proposals/proposal-dialog";

type StreamEventName =
  | "text_delta"
  | "tool_call_started"
  | "tool_call_completed"
  | "proposal_staged"
  | "ask_user_question"
  | "usage"
  | "done"
  | "error";

type StreamPayload =
  | { kind: "text_delta"; delta: string }
  | { kind: "tool_call_started"; callId: string; name: string; arguments: Record<string, unknown> }
  | { kind: "tool_call_completed"; callId: string; ok: boolean }
  | { kind: "proposal_staged"; proposalId: string; proposalKind: string; toolName: string }
  | {
      kind: "ask_user_question";
      question: string;
      options: readonly string[] | null;
      multiSelect: boolean;
    }
  | { kind: "usage"; tokensIn: number; tokensOut: number; costCents?: number }
  | { kind: "done" }
  | { kind: "error"; message: string };

type StreamingState = {
  text: string;
  toolCalls: { callId: string; name: string; ok: boolean | null }[];
  question: { question: string; options: readonly string[] | null; multiSelect: boolean } | null;
  error: string | null;
  done: boolean;
};

const EMPTY_STREAM: StreamingState = {
  text: "",
  toolCalls: [],
  question: null,
  error: null,
  done: true,
};

/**
 * Per-item chat panel. Streams the assistant turn over SSE and reconciles
 * with the persisted transcript (`conversations.get`) once the turn closes.
 */
export function ChatPanel({ projectId, itemId }: { projectId: string; itemId: string }) {
  const utils = trpc.useUtils();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<StreamingState>(EMPTY_STREAM);
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  // Auto-scroll to bottom on new messages or streaming text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when messages or stream advances, even though the body only reads scrollRef.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.length, streaming.text]);

  // Cleanup on unmount: kill any in-flight stream.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const drainStream = useCallback(
    async (id: string, content: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming({ text: "", toolCalls: [], question: null, error: null, done: false });

      const url = `/api/projects/${projectId}/conversations/${id}/stream`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        setStreaming({
          text: "",
          toolCalls: [],
          question: null,
          error: err instanceof Error ? err.message : String(err),
          done: true,
        });
        return;
      }
      if (!response.ok || !response.body) {
        const message = response.statusText || `HTTP ${response.status}`;
        setStreaming({ text: "", toolCalls: [], question: null, error: message, done: true });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Each SSE event is delimited by a blank line.
          let blankIdx: number = buffer.indexOf("\n\n");
          while (blankIdx >= 0) {
            const rawEvent = buffer.slice(0, blankIdx);
            buffer = buffer.slice(blankIdx + 2);
            blankIdx = buffer.indexOf("\n\n");
            const parsed = parseSseEvent(rawEvent);
            if (!parsed) continue;
            handleEvent(parsed);
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setStreaming((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : String(err),
          done: true,
        }));
      }

      // Refresh the persisted transcript so the streamed assistant text
      // collapses into the official `messages` list.
      await Promise.all([
        utils.conversations.list.invalidate({ projectId, itemId }),
        utils.conversations.get.invalidate({ projectId, conversationId: id }),
      ]);

      function handleEvent(event: { name: string; payload: StreamPayload }) {
        const p = event.payload;
        if (p.kind === "text_delta") {
          setStreaming((prev) => ({ ...prev, text: prev.text + p.delta }));
        } else if (p.kind === "tool_call_started") {
          setStreaming((prev) => ({
            ...prev,
            toolCalls: [...prev.toolCalls, { callId: p.callId, name: p.name, ok: null }],
          }));
        } else if (p.kind === "tool_call_completed") {
          setStreaming((prev) => ({
            ...prev,
            toolCalls: prev.toolCalls.map((tc) =>
              tc.callId === p.callId ? { ...tc, ok: p.ok } : tc,
            ),
          }));
        } else if (p.kind === "proposal_staged") {
          setPendingProposalId(p.proposalId);
        } else if (p.kind === "ask_user_question") {
          setStreaming((prev) => ({
            ...prev,
            question: { question: p.question, options: p.options, multiSelect: p.multiSelect },
          }));
        } else if (p.kind === "error") {
          setStreaming((prev) => ({ ...prev, error: p.message, done: true }));
        } else if (p.kind === "done") {
          setStreaming((prev) => ({ ...prev, done: true }));
        }
      }
    },
    [itemId, projectId, utils.conversations.get, utils.conversations.list],
  );

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
    await drainStream(id, body);
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

        {/* Live streaming bubble — replaced by a real Message row once the
            turn closes and the transcript invalidates. */}
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

function MessageBubble({ messageRole, content }: { messageRole: string; content: string }) {
  const tone =
    messageRole === "user"
      ? "self-end bg-primary/10 text-primary-foreground"
      : messageRole === "assistant"
        ? "self-start bg-muted"
        : "self-stretch border border-dashed border-border bg-muted/40 text-muted-foreground";
  const label =
    messageRole === "user"
      ? "You"
      : messageRole === "assistant"
        ? "Assistant"
        : messageRole === "system"
          ? "System"
          : messageRole;
  return (
    <div className={`max-w-[85%] rounded-md px-3 py-2 text-sm ${tone}`}>
      <div className="mb-1 text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="whitespace-pre-wrap break-words text-sm text-foreground">{content}</div>
    </div>
  );
}

function parseSseEvent(rawEvent: string): { name: StreamEventName; payload: StreamPayload } | null {
  let name: StreamEventName | null = null;
  const dataLines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("event: ")) name = line.slice(7).trim() as StreamEventName;
    else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
  }
  if (!name || dataLines.length === 0) return null;
  try {
    const payload = JSON.parse(dataLines.join("\n")) as StreamPayload;
    return { name, payload };
  } catch {
    return null;
  }
}
