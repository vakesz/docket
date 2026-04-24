import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { ApiError, api, type DTO } from "~/api/client";
import { qk } from "~/api/keys";

import {
  applyStreamEvent,
  type ChatMessage,
  initialState,
  type ReducerState,
} from "./chatStreamReducer";

export type { ChatMessage } from "./chatStreamReducer";

interface UseChatStreamOpts {
  itemId: string;
  onProposal: (p: DTO["ProposalDTO"]) => void;
}

/**
 * Drives one agent turn over `/items/{id}/conversation/messages`.
 *
 * Bubbles are appended in SSE arrival order: each "run" of `delta` events
 * opens one assistant bubble, a tool event seals that bubble and appends a
 * tool row, and the next delta opens a fresh assistant bubble below the tool.
 * This keeps chronological order (thinking → tool → thinking → final) instead
 * of pinning all assistant text to the first slot and stacking tools beneath
 * it. See `chatStreamReducer.ts` for the pure state-transition logic.
 */
export function useChatStream({ itemId, onProposal }: UseChatStreamOpts) {
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setStreaming(false);
    setError(null);
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || streaming) return;
      setError(null);
      const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const firstAssistantId = `assistant-${turnId}-0`;
      // Local mutable state for this turn — we apply the reducer to this and
      // then publish the resulting message list to React. Keeping the state
      // local (instead of using a useReducer) avoids stale-closure races with
      // rapid-fire delta callbacks.
      let state: ReducerState = initialState(turnId, text, firstAssistantId);
      const ctx = {
        turnId,
        mkToolCallId: () => `tool-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mkToolId: () => `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      };

      const publish = () =>
        setMessages((prev) => [...prev.filter((m) => m.turnId !== turnId), ...state.messages]);

      // Seed user + empty assistant so the "thinking…" placeholder shows
      // immediately after submission.
      setMessages((prev) => [...prev, ...state.messages]);
      setStreaming(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      let completed = false;
      try {
        for await (const ev of api.stream(
          `/items/${encodeURIComponent(itemId)}/conversation/messages`,
          { text },
          ctrl.signal,
        )) {
          if (ev.event === "delta") {
            const parsed = parseDelta(ev.data);
            if (parsed) {
              state = applyStreamEvent(state, { kind: "delta", text: parsed }, ctx);
              publish();
            }
          } else if (ev.event === "message") {
            const msg = parseMessage(ev.data);
            if (!msg) continue;
            if (msg.role === "assistant" && msg.tool_calls.length > 0) {
              const names = msg.tool_calls.map((tc) => tc.name).join(", ");
              state = applyStreamEvent(state, { kind: "assistant_tool_calls", names }, ctx);
              publish();
            } else if (msg.role === "tool") {
              state = applyStreamEvent(
                state,
                { kind: "tool", name: msg.name ?? "tool", content: msg.content },
                ctx,
              );
              publish();
            }
          } else if (ev.event === "proposal") {
            const proposal = parseProposal(ev.data);
            if (proposal) onProposal(proposal);
          } else if (ev.event === "error") {
            setError(parseError(ev.data));
          } else if (ev.event === "done") {
            completed = true;
            break;
          }
        }
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setError(e instanceof ApiError ? e.message : String(e));
        }
      } finally {
        setStreaming(false);
        state = applyStreamEvent(state, { kind: "seal" }, ctx);
        publish();
        if (completed) {
          // The server transcript is the source of truth once a turn finishes.
          await Promise.allSettled([
            qc.invalidateQueries({ queryKey: qk.conversation(itemId) }),
            qc.invalidateQueries({ queryKey: qk.status() }),
          ]);
          setMessages((prev) => prev.filter((message) => message.turnId !== turnId));
        } else {
          await qc.invalidateQueries({ queryKey: qk.status() });
        }
        abortRef.current = null;
      }
    },
    [itemId, onProposal, qc, streaming],
  );

  return { messages, streaming, error, send, reset, stop };
}

function parseDelta(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as { text?: string };
    return parsed.text ?? null;
  } catch (err) {
    console.warn("chat: dropped malformed SSE delta", { err, data });
    return null;
  }
}

interface ParsedToolCall {
  id?: string;
  name: string;
  arguments?: string;
}

interface ParsedMessage {
  role: string;
  content: string;
  name?: string;
  tool_calls: ParsedToolCall[];
}

function parseMessage(data: string): ParsedMessage | null {
  try {
    const parsed = JSON.parse(data) as {
      role?: unknown;
      content?: unknown;
      name?: unknown;
      tool_calls?: unknown;
    };
    if (typeof parsed.role !== "string") return null;
    const toolCalls: ParsedToolCall[] = [];
    if (Array.isArray(parsed.tool_calls)) {
      for (const tc of parsed.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const record = tc as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name : null;
        if (!name) continue;
        toolCalls.push({
          name,
          id: typeof record.id === "string" ? record.id : undefined,
          arguments: typeof record.arguments === "string" ? record.arguments : undefined,
        });
      }
    }
    return {
      role: parsed.role,
      content: typeof parsed.content === "string" ? parsed.content : "",
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      tool_calls: toolCalls,
    };
  } catch (err) {
    console.warn("chat: dropped malformed SSE message", { err, data });
    return null;
  }
}

function parseProposal(data: string): DTO["ProposalDTO"] | null {
  try {
    return JSON.parse(data) as DTO["ProposalDTO"];
  } catch (err) {
    console.warn("chat: dropped malformed SSE proposal", { err, data });
    return null;
  }
}

function parseError(data: string): string {
  try {
    const parsed = JSON.parse(data) as { detail?: string };
    return parsed.detail ?? data;
  } catch {
    return data;
  }
}
