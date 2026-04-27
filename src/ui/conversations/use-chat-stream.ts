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

  const drainStream = useCallback(
    async ({ projectId, itemId, conversationId, content }: DrainArgs) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming({ text: "", toolCalls: [], question: null, error: null, done: false });

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
          done: true,
        }));
      }

      await Promise.all([
        utils.conversations.list.invalidate({ projectId, itemId }),
        utils.conversations.get.invalidate({ projectId, conversationId }),
      ]);

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
        } else if (p.kind === "proposal_staged") {
          setProposalIds((prev) => (prev.includes(p.proposalId) ? prev : [...prev, p.proposalId]));
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
    [utils.conversations.get, utils.conversations.list],
  );

  return { streaming, proposalIds, dismissProposal, drainStream, resetStream };
}
