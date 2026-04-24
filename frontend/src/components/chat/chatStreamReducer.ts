/**
 * Pure reducer for the chat stream. Pulls the state-transition logic out of
 * the `useChatStream` hook so the interleaving behavior (assistant bubbles
 * mount chronologically, tool events seal the current bubble, next delta
 * opens a new one, empty preamble bubbles are dropped when a tool arrives)
 * can be unit-tested without a React renderer.
 */

export type ChatMessage =
  | { kind: "user"; id: string; turnId: string; text: string }
  | { kind: "assistant"; id: string; turnId: string; text: string; streaming: boolean }
  | { kind: "tool"; id: string; turnId: string; name: string; text: string }
  | { kind: "tool_call"; id: string; turnId: string; names: string };

export type StreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "assistant_tool_calls"; names: string }
  | { kind: "tool"; name: string; content: string }
  | { kind: "seal" };

export interface ReducerState {
  messages: ChatMessage[];
  activeAssistantId: string | null;
  assistantCounter: number;
}

export interface ReducerCtx {
  turnId: string;
  /** Monotonic id factory — tests inject a deterministic version. */
  mkToolCallId: () => string;
  mkToolId: () => string;
}

export function initialState(
  turnId: string,
  userText: string,
  firstAssistantId: string,
): ReducerState {
  return {
    messages: [
      { kind: "user", id: `user-${turnId}`, turnId, text: userText },
      { kind: "assistant", id: firstAssistantId, turnId, text: "", streaming: true },
    ],
    activeAssistantId: firstAssistantId,
    assistantCounter: 1,
  };
}

export function applyStreamEvent(
  state: ReducerState,
  event: StreamEvent,
  ctx: ReducerCtx,
): ReducerState {
  switch (event.kind) {
    case "delta":
      return appendAssistantText(state, event.text, ctx);
    case "tool": {
      const sealed = sealActiveAssistant(state);
      return {
        ...sealed,
        messages: [
          ...sealed.messages,
          {
            kind: "tool",
            id: ctx.mkToolId(),
            turnId: ctx.turnId,
            name: event.name,
            text: event.content,
          },
        ],
      };
    }
    case "assistant_tool_calls": {
      const sealed = sealActiveAssistant(state);
      return {
        ...sealed,
        messages: [
          ...sealed.messages,
          {
            kind: "tool_call",
            id: ctx.mkToolCallId(),
            turnId: ctx.turnId,
            names: event.names,
          },
        ],
      };
    }
    case "seal":
      return sealActiveAssistant(state);
  }
}

function appendAssistantText(state: ReducerState, chunk: string, ctx: ReducerCtx): ReducerState {
  if (state.activeAssistantId) {
    const activeId = state.activeAssistantId;
    return {
      ...state,
      messages: state.messages.map((m) =>
        m.id === activeId && m.kind === "assistant" ? { ...m, text: m.text + chunk } : m,
      ),
    };
  }
  const newId = `assistant-${ctx.turnId}-${state.assistantCounter}`;
  return {
    ...state,
    activeAssistantId: newId,
    assistantCounter: state.assistantCounter + 1,
    messages: [
      ...state.messages,
      { kind: "assistant", id: newId, turnId: ctx.turnId, text: chunk, streaming: true },
    ],
  };
}

function sealActiveAssistant(state: ReducerState): ReducerState {
  const activeId = state.activeAssistantId;
  if (!activeId) return state;
  const target = state.messages.find((m) => m.id === activeId);
  if (target && target.kind === "assistant" && target.text === "") {
    // Nothing streamed into it — drop the empty placeholder so no stale "…"
    // lingers above subsequent tool rows.
    return {
      ...state,
      activeAssistantId: null,
      messages: state.messages.filter((m) => m.id !== activeId),
    };
  }
  return {
    ...state,
    activeAssistantId: null,
    messages: state.messages.map((m) =>
      m.id === activeId && m.kind === "assistant" ? { ...m, streaming: false } : m,
    ),
  };
}
