import { describe, expect, test } from "bun:test";

import {
  applyStreamEvent,
  type ChatMessage,
  initialState,
  type ReducerCtx,
  type ReducerState,
  type StreamEvent,
} from "./chatStreamReducer";

function expectAssistant(
  m: ChatMessage | undefined,
): asserts m is Extract<ChatMessage, { kind: "assistant" }> {
  expect(m?.kind).toBe("assistant");
}

function mkCtx(turnId = "T1"): ReducerCtx {
  let tc = 0;
  let tr = 0;
  return {
    turnId,
    mkToolCallId: () => `tc-${tc++}`,
    mkToolId: () => `tr-${tr++}`,
  };
}

function run(events: StreamEvent[], { seal = true }: { seal?: boolean } = {}): ReducerState {
  const ctx = mkCtx();
  let state = initialState(ctx.turnId, "hi", `assistant-${ctx.turnId}-0`);
  for (const ev of events) state = applyStreamEvent(state, ev, ctx);
  if (seal) state = applyStreamEvent(state, { kind: "seal" }, ctx);
  return state;
}

describe("chatStreamReducer", () => {
  test("initial state has user + empty streaming assistant", () => {
    const s = initialState("T1", "hi", "assistant-T1-0");
    expect(s.messages.map((m) => m.kind)).toEqual(["user", "assistant"]);
    expect(s.activeAssistantId).toBe("assistant-T1-0");
  });

  test("delta-only turn fills the initial assistant bubble", () => {
    const s = run([
      { kind: "delta", text: "Hel" },
      { kind: "delta", text: "lo" },
    ]);
    expect(s.messages.map((m) => m.kind)).toEqual(["user", "assistant"]);
    const a = s.messages[1];
    expectAssistant(a);
    expect(a.text).toBe("Hello");
    expect(a.streaming).toBe(false);
  });

  test("tool after no preamble drops the empty assistant bubble", () => {
    const s = run([
      { kind: "tool", name: "get_item", content: "{...}" },
      { kind: "delta", text: "Done." },
    ]);
    expect(s.messages.map((m) => m.kind)).toEqual(["user", "tool", "assistant"]);
    const last = s.messages[2];
    expectAssistant(last);
    expect(last.text).toBe("Done.");
  });

  test("preamble → tool → final produces three chronological bubbles", () => {
    const s = run([
      { kind: "delta", text: "Let me look that up." },
      { kind: "assistant_tool_calls", names: "get_item" },
      { kind: "tool", name: "get_item", content: "ok" },
      { kind: "delta", text: "Answer." },
    ]);
    // user, preamble assistant, tool_call notice, tool result, final assistant
    expect(s.messages.map((m) => m.kind)).toEqual([
      "user",
      "assistant",
      "tool_call",
      "tool",
      "assistant",
    ]);
    const preamble = s.messages[1];
    const final = s.messages[4];
    expectAssistant(preamble);
    expectAssistant(final);
    expect(preamble.text).toBe("Let me look that up.");
    expect(preamble.streaming).toBe(false);
    expect(final.text).toBe("Answer.");
    expect(final.streaming).toBe(false);
  });

  test("two tool rounds interleave with two assistant bubbles", () => {
    const s = run([
      { kind: "delta", text: "thinking" },
      { kind: "tool", name: "t1", content: "a" },
      { kind: "delta", text: "more thinking" },
      { kind: "tool", name: "t2", content: "b" },
      { kind: "delta", text: "final" },
    ]);
    expect(s.messages.map((m) => m.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    const texts = s.messages.flatMap((m) => (m.kind === "assistant" ? [m.text] : []));
    expect(texts).toEqual(["thinking", "more thinking", "final"]);
  });

  test("seal on an empty active bubble drops it instead of leaving a '…' row", () => {
    // Simulates an abort/error right after send before any deltas arrive.
    const s = run([], { seal: true });
    expect(s.messages.map((m) => m.kind)).toEqual(["user"]);
    expect(s.activeAssistantId).toBeNull();
  });

  test("seal flips streaming=false on a non-empty active bubble", () => {
    const s = run([{ kind: "delta", text: "x" }]);
    const a = s.messages[1];
    expectAssistant(a);
    expect(a.streaming).toBe(false);
  });

  test("assistant_tool_calls with preamble retains the preamble bubble", () => {
    // If the model emitted text, we keep it even when it also calls a tool.
    const s = run([
      { kind: "delta", text: "heads up" },
      { kind: "assistant_tool_calls", names: "search" },
    ]);
    expect(s.messages.map((m) => m.kind)).toEqual(["user", "assistant", "tool_call"]);
    const a = s.messages[1];
    expectAssistant(a);
    expect(a.text).toBe("heads up");
    expect(a.streaming).toBe(false); // sealed by the tool_call event
  });
});
