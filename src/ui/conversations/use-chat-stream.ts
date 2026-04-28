"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import {
  EMPTY_STREAM,
  parseSseEvent,
  type StreamingState,
  type StreamPayload,
} from "@/ui/conversations/chat-stream";

type DrainArgs = {
  projectId: string;
  itemId: string;
  conversationId: string;
  content: string;
};

type StopArgs = {
  projectId: string;
  itemId: string;
  conversationId: string;
};

type UseChatStream = {
  streaming: StreamingState;
  /**
   * Proposal ids the agent has staged during this conversation, in order
   * of arrival. Each is rendered inline as a non-blocking card so the user
   * can keep typing while reviewing.
   */
  proposalIds: readonly string[];
  /** Drop one proposal card from the inline list (e.g. after dismiss). */
  dismissProposal: (id: string) => void;
  drainStream: (args: DrainArgs) => Promise<void>;
  /** Abort any in-flight stream and clear local stream state. */
  resetStream: () => void;
  /**
   * User-triggered stop: aborts the in-flight stream and refetches the
   * persisted transcript so any rows the loop already flushed (the user
   * message, partial assistant text) appear immediately. Unlike
   * `resetStream`, this is meant to be wired to a Stop button in the UI.
   */
  stopStream: (args: StopArgs) => Promise<void>;
};

/**
 * Owns the SSE chat stream for one conversation: aborts any in-flight
 * stream on a new send, parses events as they arrive, and refreshes the
 * persisted transcript via tRPC `invalidate` once the turn closes so the
 * streamed bubble collapses into the official message list.
 *
 * The hook holds no projectId/itemId itself — those are passed per-call
 * from the chat panel so this stays trivially testable.
 */
export function useChatStream(): UseChatStream {
  const utils = trpc.useUtils();
  const [streaming, setStreaming] = useState<StreamingState>(EMPTY_STREAM);
  const [proposalIds, setProposalIds] = useState<readonly string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const resetStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(EMPTY_STREAM);
    setProposalIds([]);
  }, []);

  const dismissProposal = useCallback((id: string) => {
    setProposalIds((prev) => prev.filter((p) => p !== id));
  }, []);

  const stopStream = useCallback(
    async ({ projectId, itemId, conversationId }: StopArgs) => {
      abortRef.current?.abort();
      abortRef.current = null;
      await Promise.all([
        utils.conversations.list.invalidate({ projectId, itemId }),
        utils.conversations.get.invalidate({ projectId, conversationId }),
      ]);
      setStreaming(EMPTY_STREAM);
    },
    [utils.conversations.get, utils.conversations.list],
  );

  const drainStream = useCallback(
    async ({ projectId, itemId, conversationId, content }: DrainArgs) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming({
        pendingUserMessage: content,
        settledRounds: [],
        text: "",
        toolCalls: [],
        question: null,
        error: null,
        done: false,
      });

      const url = `/api/projects/${projectId}/conversations/${conversationId}/stream`;
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
          pendingUserMessage: null,
          settledRounds: [],
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
        setStreaming({
          pendingUserMessage: null,
          settledRounds: [],
          text: "",
          toolCalls: [],
          question: null,
          error: message,
          done: true,
        });
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

          let blankIdx: number = buffer.indexOf("\n\n");
          while (blankIdx >= 0) {
            const rawEvent = buffer.slice(0, blankIdx);
            buffer = buffer.slice(blankIdx + 2);
            blankIdx = buffer.indexOf("\n\n");
            const parsed = parseSseEvent(rawEvent);
            if (!parsed) continue;
            applyPayload(parsed.payload);
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setStreaming((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : String(err),
        }));
      }

      // Refetch the persisted transcript BEFORE flipping `done` so the
      // streaming bubble + settled-rounds snapshot stay visible until
      // detail.data has the official rows. Otherwise React would render
      // one frame with the streaming UI gone but the persisted version
      // not yet in place — a visible blink at end-of-stream.
      await Promise.all([
        utils.conversations.list.invalidate({ projectId, itemId }),
        utils.conversations.get.invalidate({ projectId, conversationId }),
      ]);
      if (controller.signal.aborted) return;
      setStreaming((prev) => ({
        ...prev,
        pendingUserMessage: null,
        settledRounds: [],
        text: "",
        toolCalls: [],
        done: true,
      }));

      function applyPayload(p: StreamPayload) {
        if (p.kind === "text_delta") {
          setStreaming((prev) => ({ ...prev, text: prev.text + p.delta }));
        } else if (p.kind === "tool_call_started") {
          setStreaming((prev) => ({
            ...prev,
            toolCalls: [
              ...prev.toolCalls,
              { callId: p.callId, name: p.name, arguments: p.arguments, ok: null },
            ],
          }));
        } else if (p.kind === "tool_call_completed") {
          setStreaming((prev) => ({
            ...prev,
            toolCalls: prev.toolCalls.map((tc) =>
              tc.callId === p.callId ? { ...tc, ok: p.ok } : tc,
            ),
          }));
        } else if (p.kind === "round_boundary") {
          // Snapshot the round that just finished into settledRounds and
          // reset live state so the next round starts with a fresh bubble
          // / progress block. The persisted rows for this round are
          // already in the DB; the next `invalidate` will replace
          // settledRounds with the official transcript.
          setStreaming((prev) => {
            const hasContent = prev.text.length > 0 || prev.toolCalls.length > 0;
            if (!hasContent) return prev;
            return {
              ...prev,
              settledRounds: [
                ...prev.settledRounds,
                { text: prev.text, toolCalls: prev.toolCalls },
              ],
              text: "",
              toolCalls: [],
            };
          });
        } else if (p.kind === "proposal_staged") {
          setProposalIds((prev) => (prev.includes(p.proposalId) ? prev : [...prev, p.proposalId]));
        } else if (p.kind === "ask_user_question") {
          setStreaming((prev) => ({
            ...prev,
            question: { question: p.question, options: p.options, multiSelect: p.multiSelect },
          }));
        } else if (p.kind === "error") {
          setStreaming((prev) => ({ ...prev, error: p.message }));
        }
        // `done` is intentionally a no-op — the post-loop finalizer flips
        // streaming.done after invalidate so the persisted view is in
        // place before the streaming UI disappears.
      }
    },
    [utils.conversations.get, utils.conversations.list],
  );

  return { streaming, proposalIds, dismissProposal, drainStream, resetStream, stopStream };
}
