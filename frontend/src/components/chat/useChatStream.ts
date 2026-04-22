import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { ApiError, api, type DTO } from "~/api/client";
import { qk } from "~/api/keys";

export type ChatMessage =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "tool"; id: string; name: string; text: string };

interface UseChatStreamOpts {
  itemId: string;
  onProposal: (p: DTO["ProposalDTO"]) => void;
}

/**
 * Drives one agent turn over `/items/{id}/conversation/messages`.
 *
 * We keep a local message list separate from the query cache — the cache only
 * stores the persisted transcript, while this hook accumulates the live SSE
 * stream (assistant deltas, tool calls, staged proposals). On `done` we
 * invalidate the conversation query so the cache picks up the server copy.
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
      const assistantId = `assistant-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { kind: "user", id: `user-${Date.now()}`, text },
        { kind: "assistant", id: assistantId, text: "", streaming: true },
      ]);
      setStreaming(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        for await (const ev of api.stream(
          `/items/${encodeURIComponent(itemId)}/conversation/messages`,
          { text },
          ctrl.signal,
        )) {
          if (ev.event === "delta") {
            const parsed = parseDelta(ev.data);
            if (parsed) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId && m.kind === "assistant"
                    ? { ...m, text: m.text + parsed }
                    : m,
                ),
              );
            }
          } else if (ev.event === "message") {
            const msg = parseMessage(ev.data);
            if (msg?.role === "tool") {
              setMessages((prev) => [
                ...prev,
                {
                  kind: "tool",
                  id: `tool-${Date.now()}-${Math.random()}`,
                  name: msg.name ?? "tool",
                  text: msg.content,
                },
              ]);
            }
          } else if (ev.event === "proposal") {
            const proposal = parseProposal(ev.data);
            if (proposal) onProposal(proposal);
          } else if (ev.event === "error") {
            setError(parseError(ev.data));
          } else if (ev.event === "done") {
            break;
          }
        }
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setError(e instanceof ApiError ? e.message : String(e));
        }
      } finally {
        setStreaming(false);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId && m.kind === "assistant" ? { ...m, streaming: false } : m,
          ),
        );
        qc.invalidateQueries({ queryKey: qk.conversation(itemId) });
        qc.invalidateQueries({ queryKey: qk.status() });
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
  } catch {
    return null;
  }
}

interface ParsedMessage {
  role: string;
  content: string;
  name?: string;
}

function parseMessage(data: string): ParsedMessage | null {
  try {
    const parsed = JSON.parse(data) as ParsedMessage;
    if (typeof parsed.role !== "string") return null;
    return {
      role: parsed.role,
      content: typeof parsed.content === "string" ? parsed.content : "",
      name: parsed.name,
    };
  } catch {
    return null;
  }
}

function parseProposal(data: string): DTO["ProposalDTO"] | null {
  try {
    return JSON.parse(data) as DTO["ProposalDTO"];
  } catch {
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
