/**
 * Scripted fake LlmAdapter for tests.
 *
 * The agent loop only sees `LlmAdapter` values, so a hand-scripted fake is
 * the cleanest way to drive deterministic loop tests without ever touching
 * the OpenAI SDK. Mirrors `tests/fakes/llm.py` from the Python tree.
 *
 * Usage:
 *
 *   const llm = new FakeLlm([
 *     [{ kind: "text_delta", delta: "Hello" }, { kind: "done" }],
 *     [{ kind: "tool_call", call: ... }, { kind: "done" }],
 *   ]);
 *
 * Each inner array is one `streamMessages()` call's event sequence. The
 * adapter advances through the script with each call so the test can
 * assert exact turn-by-turn behavior.
 */

import type {
  LlmAdapter,
  LlmEvent,
  LlmRequest,
  LlmToolCall,
  LlmToolResult,
} from "@/agent/llm/types";

export type FakeTurn = readonly LlmEvent[];

export class FakeLlm implements LlmAdapter {
  readonly kind = "openai" as const;
  readonly label = "Fake · scripted";

  /** Snapshot of every request the loop made — useful for assertions. */
  readonly requests: LlmRequest[] = [];

  private cursor = 0;
  private readonly script: readonly FakeTurn[];

  constructor(script: readonly FakeTurn[]) {
    this.script = script;
  }

  async *streamMessages(req: LlmRequest): AsyncIterable<LlmEvent> {
    this.requests.push(req);
    if (this.cursor >= this.script.length) {
      throw new Error(
        `FakeLlm: agent asked for turn #${this.cursor + 1} but script only has ${this.script.length}`,
      );
    }
    const turn = this.script[this.cursor++];
    for (const event of turn) {
      yield event;
    }
  }

  formatToolResult(call: LlmToolCall, result: unknown): LlmToolResult {
    return {
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content: typeof result === "string" ? result : JSON.stringify(result),
    };
  }
}
