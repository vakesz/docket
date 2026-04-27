"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { metaLabelClass, metaLabelFaintClass, microCapsButtonClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { type ToolDisplayMode, useToolDisplayMode } from "@/lib/ui-prefs";
import { cn } from "@/lib/utils";
import { useChatPaneController } from "@/ui/conversations/chat-pane-context";
import { LlmSwitcher } from "@/ui/conversations/llm-switcher";
import { QuestionCard } from "@/ui/conversations/question-card";
import { useChatStream } from "@/ui/conversations/use-chat-stream";
import { Markdown } from "@/ui/markdown/markdown";
import { ProposalCard } from "@/ui/proposals/proposal-card";

type PersistedMessage = {
  id: string;
  role: string;
  content: string;
  toolName: string | null;
  toolCallId: string | null;
  toolCallsJson: unknown;
};

type AssistantToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type RenderUnit =
  | { kind: "text"; key: string; role: string; content: string }
  | {
      kind: "tool_call";
      key: string;
      toolCallId: string | null;
      name: string;
      arguments: Record<string, unknown> | null;
      result: string;
      ok: boolean | null;
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

  const { streaming, proposalIds, dismissProposal, drainStream, resetStream } = useChatStream();
  const [toolDisplayMode] = useToolDisplayMode();
  const { pendingSeed, consumeSeed } = useChatPaneController();

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
  const renderUnits = useMemo(() => buildRenderUnits(messages), [messages]);
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

  // Consume a queued "Suggest next action" seed: open a fresh thread and
  // submit it as a normal user message. We start a *new* thread so the
  // suggestion isn't appended to whatever the user was last asking about
  // for this item — distinct entry point, distinct conversation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingSeed is the trigger; the rest is captured.
  useEffect(() => {
    if (!pendingSeed) return;
    if (inFlight) return;
    const seed = pendingSeed;
    consumeSeed();
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
            {renderUnits.map((unit) => {
              if (unit.kind === "text") {
                return <Bubble key={unit.key} messageRole={unit.role} text={unit.content} />;
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
            {(proposalIds.length > 0 || streaming.question) && (
              <div className="sticky bottom-0 -mx-3 mt-3 flex flex-col gap-2 border-t border-border bg-bg/95 px-3 pb-1 pt-2 backdrop-blur-sm">
                {proposalIds.map((id) => (
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
        <div className={cn("mt-1 flex items-center justify-between gap-2", metaLabelFaintClass)}>
          <LlmSwitcher
            projectId={projectId}
            conversationId={conversationId}
            currentOverrideId={detail.data?.llmProviderIdOverride ?? null}
          />
          <div className="flex items-center gap-2">
            {create.error && <span className="text-danger-fg">{create.error.message}</span>}
            <span>{inFlight ? "Streaming…" : "Ready"}</span>
          </div>
        </div>
      </form>
    </div>
  );
}

function condenseArgs(args: Record<string, unknown> | null, maxLen = 100): string {
  if (!args) return "";
  let serialized: string;
  try {
    serialized = JSON.stringify(args);
  } catch {
    return "";
  }
  if (!serialized || serialized === "{}") return "";
  return serialized.length > maxLen ? `${serialized.slice(0, maxLen)}…` : serialized;
}

function parseAssistantToolCalls(raw: unknown): AssistantToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: AssistantToolCall[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : null;
    const name = typeof e.name === "string" ? e.name : null;
    const args =
      e.arguments && typeof e.arguments === "object"
        ? (e.arguments as Record<string, unknown>)
        : {};
    if (!id || !name) continue;
    out.push({ id, name, arguments: args });
  }
  return out;
}

/**
 * Walk the persisted transcript once and pair each assistant tool-call
 * with its matching `role: "tool"` result row. The chat used to render
 * the two halves as separate cards; pairing them keeps each call's
 * arguments and output in one collapsible row.
 */
function buildRenderUnits(messages: readonly PersistedMessage[]): RenderUnit[] {
  const toolByCallId = new Map<string, PersistedMessage>();
  const consumed = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) {
      toolByCallId.set(m.toolCallId, m);
    }
  }

  const units: RenderUnit[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") continue;
    if (m.role === "assistant") {
      const calls = parseAssistantToolCalls(m.toolCallsJson);
      const hasText = m.content.trim().length > 0;
      if (hasText) {
        units.push({ kind: "text", key: `${m.id}:text`, role: m.role, content: m.content });
      }
      for (const call of calls) {
        const result = toolByCallId.get(call.id) ?? null;
        if (result) consumed.add(call.id);
        units.push({
          kind: "tool_call",
          key: `${m.id}:${call.id}`,
          toolCallId: call.id,
          name: call.name,
          arguments: call.arguments,
          result: result?.content ?? "",
          ok: null,
        });
      }
      continue;
    }
    units.push({ kind: "text", key: `${m.id}:text`, role: m.role, content: m.content });
  }

  // Orphan tool results — should not happen, but rather than swallow them
  // surface them as fallback rows so a missing assistant turn is visible.
  for (const m of messages) {
    if (m.role !== "tool" || !m.toolCallId) continue;
    if (consumed.has(m.toolCallId)) continue;
    units.push({
      kind: "tool_call",
      key: `${m.id}:orphan`,
      toolCallId: m.toolCallId,
      name: m.toolName ?? "tool",
      arguments: null,
      result: m.content,
      ok: null,
    });
  }

  return units;
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
      {text ? (
        <Markdown source={text} className="text-fg" />
      ) : (
        <p className="text-fg">{streaming ? "…" : ""}</p>
      )}
    </div>
  );
}

function ToolCallRow({
  name,
  args,
  result,
  ok,
  mode,
}: {
  name: string;
  args: Record<string, unknown> | null;
  result: string;
  ok: boolean | null;
  mode: ToolDisplayMode;
}) {
  // Initial open state derives from `mode` once; after the user toggles, the
  // row owns its own open state so flipping the global pref doesn't snap-
  // collapse a result they just expanded.
  const [open, setOpen] = useState(mode === "show");

  if (mode === "hide") return null;

  const isMcp = name.includes("__");
  const label = `${isMcp ? "mcp" : "tool"} · ${name}`;
  const status = ok === true ? "✓" : ok === false ? "✗" : "";

  const argsPreview = condenseArgs(args, 100);
  const resultFirstLine = result.split("\n", 1)[0]?.trim() ?? "";
  const fallbackPreview =
    resultFirstLine.length > 100 ? `${resultFirstLine.slice(0, 100)}…` : resultFirstLine;
  const preview = argsPreview || fallbackPreview;

  const errored = ok === false;
  const palette = errored ? "bg-danger-bg text-danger-fg" : "bg-warning-bg text-warning-fg";
  const hoverBg = errored ? "hover:bg-danger-bg/70" : "hover:bg-warning-bg/70";

  const prettyArgs = args ? safeStringify(args) : null;

  return (
    <div className={cn("mb-3 overflow-hidden rounded", palette)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn("flex w-full items-center gap-2 px-3 py-2 text-left", hoverBg)}
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className={metaLabelClass}>{label}</span>
        {status && <span className="font-mono text-[11px]">{status}</span>}
        {!open && preview && (
          <span className="truncate font-mono text-[11px] text-fg-faint">{preview}</span>
        )}
      </button>
      {open && (
        <div className="flex flex-col">
          {prettyArgs !== null && (
            <div className="px-3 pb-2">
              <div className={cn("mb-1", metaLabelClass)}>arguments</div>
              <pre className="whitespace-pre-wrap font-mono text-xs">{prettyArgs}</pre>
            </div>
          )}
          {result && (
            <div
              className={cn("px-3 pb-2", prettyArgs !== null && "border-t border-border/40 pt-2")}
            >
              <div className={cn("mb-1", metaLabelClass)}>result</div>
              <pre className="whitespace-pre-wrap font-mono text-xs">{result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function safeStringify(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable]";
  }
}

function ToolCallProgress({
  toolCalls,
  mode,
  streaming,
}: {
  toolCalls: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
    ok: boolean | null;
  }[];
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
      {toolCalls.map((tc) => {
        const arrow = tc.ok === null ? "→" : tc.ok ? "✓" : "✗";
        const argSummary = condenseArgs(tc.arguments, 80);
        return (
          <div key={tc.callId} className="truncate">
            {arrow} {tc.name}
            {argSummary ? `(${argSummary})` : "()"}
          </div>
        );
      })}
    </div>
  );
}
