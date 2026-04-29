/**
 * Agent loop tests against the scripted fake LLM.
 *
 * These tests drive `runTurn()` end-to-end without touching Postgres or
 * the OpenAI SDK: a hand-rolled in-memory Prisma stub satisfies the
 * narrow shape the loop reaches for, and `FakeLlm` from
 * `tests/fakes/llm.ts` plays back a pre-baked event sequence.
 *
 * What we're protecting:
 *   - text-only turns persist a single assistant message and stream the
 *     deltas in order
 *   - tool calls dispatch to the registered handler, re-feed the result,
 *     and resume the loop on the next turn
 *   - `ask_user_question` ends the turn early (no further LLM round)
 *   - the iteration cap (`chat.max-tool-rounds`) trips with a clear error
 *     instead of running forever
 *   - usage events accumulate and are written back to the conversation row
 */

import { describe, expect, it } from "vitest";
import type { LlmEvent } from "@/agent/llm/types";
import { runTurn } from "@/agent/loop";
import type { db as Db } from "@/server/db";
import { FakeLlm } from "../../tests/fakes/llm";

type Database = typeof Db;

function makeStubDb(): {
  db: Database;
  state: {
    messages: { conversationId: string; role: string; content: string; toolName: string | null }[];
    convUpdates: { tokensIn: number; tokensOut: number; costCents: number }[];
  };
} {
  const messages: {
    id: string;
    conversationId: string;
    role: string;
    content: string;
    toolCallsJson: unknown;
    toolCallId: string | null;
    toolName: string | null;
    pending: boolean;
    compacted: boolean;
    createdAt: Date;
  }[] = [];
  const convUpdates: { tokensIn: number; tokensOut: number; costCents: number }[] = [];
  let nextId = 1;
  const conv = {
    id: "conv_1",
    projectId: "proj_1",
    userId: "user_1",
    itemId: null,
    llmProviderIdOverride: null,
    project: {
      id: "proj_1",
      defaultLlmProviderId: null,
      defaultGuardrailProviderId: null,
    },
  };
  const fake = {
    conversation: {
      findUnique: async (args: { where: { id: string }; include?: unknown }) => {
        if (args.where.id !== conv.id) return null;
        if (
          args.include &&
          typeof args.include === "object" &&
          args.include !== null &&
          "messages" in args.include
        ) {
          return { ...conv, messages: messages.filter((m) => !m.compacted) };
        }
        if (
          args.include &&
          typeof args.include === "object" &&
          args.include !== null &&
          "project" in args.include
        ) {
          return { ...conv };
        }
        return { ...conv };
      },
      update: async (args: {
        where: { id: string };
        data: {
          tokensIn?: { increment: number };
          tokensOut?: { increment: number };
          costCents?: { increment: number };
        };
      }) => {
        convUpdates.push({
          tokensIn: args.data.tokensIn?.increment ?? 0,
          tokensOut: args.data.tokensOut?.increment ?? 0,
          costCents: args.data.costCents?.increment ?? 0,
        });
        return conv;
      },
      // Budget guard sums month-to-date costCents; the tests don't seed any
      // history so the cap is never reached.
      aggregate: async () => ({ _sum: { costCents: 0 } }),
    },
    message: {
      findMany: async () => messages.filter((m) => !m.compacted),
      create: async (args: {
        data: {
          conversationId: string;
          role: string;
          content: string;
          toolCallsJson?: unknown;
          toolCallId?: string | null;
          toolName?: string | null;
          pending?: boolean;
        };
      }) => {
        const row = {
          id: `m_${nextId++}`,
          conversationId: args.data.conversationId,
          role: args.data.role,
          content: args.data.content,
          toolCallsJson: args.data.toolCallsJson ?? null,
          toolCallId: args.data.toolCallId ?? null,
          toolName: args.data.toolName ?? null,
          pending: args.data.pending ?? false,
          compacted: false,
          createdAt: new Date(),
        };
        messages.push(row);
        return row;
      },
    },
    item: {
      findUnique: async () => null,
    },
    mcpServerConfig: {
      // No MCP servers in tests — keep the slot 5 builder a no-op so the
      // loop tests don't have to care about remote tool fan-out.
      findMany: async () => [] as unknown[],
    },
    setting: {
      // Compaction + guardrail settings load from the Setting table; tests
      // don't seed any rows so every key falls back to its catalog default.
      findFirst: async () => null,
    },
    llmProvider: {
      // Guardrail provider lookup. No row → registry falls back to the
      // PatternGuardrail (no model needed). The pattern adapter never
      // hits the DB after that.
      findFirst: async () => null,
    },
  };
  return {
    db: fake as unknown as Database,
    state: {
      get messages() {
        return messages.map((m) => ({
          conversationId: m.conversationId,
          role: m.role,
          content: m.content,
          toolName: m.toolName,
        }));
      },
      convUpdates,
    },
  };
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("agent loop", () => {
  it("text-only turn streams deltas, persists user + assistant rows, records usage", async () => {
    const { db, state } = makeStubDb();
    const llm = new FakeLlm([
      [
        { kind: "text_delta", delta: "Hello, " },
        { kind: "text_delta", delta: "world." },
        { kind: "usage", tokensIn: 12, tokensOut: 4, costCents: 1 },
        { kind: "done" },
      ] as readonly LlmEvent[],
    ]);

    const events = await collect(
      runTurn({
        db,
        adapter: llm,
        conversationId: "conv_1",
        userId: "user_1",
        userMessage: "hi",
        readOnly: false,
      }),
    );

    expect(events.find((e) => e.kind === "done")).toBeTruthy();
    const deltas = events.filter(
      (e): e is { kind: "text_delta"; delta: string } => e.kind === "text_delta",
    );
    expect(deltas.map((e) => e.delta).join("")).toBe("Hello, world.");

    // user + assistant rows persisted in order.
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(state.messages[1].content).toBe("Hello, world.");

    // Usage event surfaced AND committed back to the conversation row.
    const usage = events.find(
      (
        e,
      ): e is {
        kind: "usage";
        tokensIn: number;
        tokensOut: number;
        costCents: number | undefined;
      } => e.kind === "usage",
    );
    expect(usage).toMatchObject({ tokensIn: 12, tokensOut: 4 });
    expect(state.convUpdates).toEqual([{ tokensIn: 12, tokensOut: 4, costCents: 1 }]);

    // Adapter saw exactly one streamMessages call.
    expect(llm.requests.length).toBe(1);
  });

  it("dispatches a tool call, re-feeds the result, and finishes on the next turn", async () => {
    const { db, state } = makeStubDb();
    const llm = new FakeLlm([
      [
        {
          kind: "tool_call",
          call: {
            id: "call_1",
            name: "list_items",
            arguments: { bucket: "open", limit: 1 },
          },
        },
        { kind: "done" },
      ],
      [{ kind: "text_delta", delta: "0 items." }, { kind: "done" }],
    ] as readonly (readonly LlmEvent[])[]);

    // list_items hits db.item.findMany — give it an empty result.
    (db as unknown as { item: { findMany: () => Promise<unknown[]> } }).item.findMany =
      async () => [];

    const events = await collect(
      runTurn({
        db,
        adapter: llm,
        conversationId: "conv_1",
        userId: "user_1",
        userMessage: "list anything",
        readOnly: false,
      }),
    );

    const startedNames = events
      .filter(
        (
          e,
        ): e is {
          kind: "tool_call_started";
          callId: string;
          name: string;
          arguments: Record<string, unknown>;
        } => e.kind === "tool_call_started",
      )
      .map((e) => e.name);
    expect(startedNames).toEqual(["list_items"]);

    expect(events.some((e) => e.kind === "tool_call_completed")).toBe(true);
    expect(events.find((e) => e.kind === "done")).toBeTruthy();

    // Persisted: user, assistant (turn 1 had only tool calls, empty text), tool result, assistant ("0 items.").
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(state.messages[3].content).toBe("0 items.");

    // Two LLM round-trips happened.
    expect(llm.requests.length).toBe(2);
  });

  it("ends the turn early on ask_user_question and emits the question event", async () => {
    const { db, state } = makeStubDb();
    const llm = new FakeLlm([
      [
        {
          kind: "tool_call",
          call: {
            id: "call_q",
            name: "ask_user_question",
            arguments: {
              question: "Which repo?",
              options: ["repo-a", "repo-b"],
              multiSelect: false,
            },
          },
        },
        { kind: "done" },
      ],
    ] as readonly (readonly LlmEvent[])[]);

    const events = await collect(
      runTurn({
        db,
        adapter: llm,
        conversationId: "conv_1",
        userId: "user_1",
        userMessage: "go",
        readOnly: false,
      }),
    );

    const q = events.find(
      (
        e,
      ): e is {
        kind: "ask_user_question";
        question: string;
        options: readonly string[] | null;
        multiSelect: boolean;
      } => e.kind === "ask_user_question",
    );
    expect(q).toMatchObject({
      question: "Which repo?",
      options: ["repo-a", "repo-b"],
      multiSelect: false,
    });

    // Loop did NOT request a second turn — it surrendered to the user.
    expect(llm.requests.length).toBe(1);

    // user + assistant + tool result rows. No second assistant text turn.
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("trips the iteration cap when the model keeps requesting tool calls", async () => {
    const { db } = makeStubDb();
    (db as unknown as { item: { findMany: () => Promise<unknown[]> } }).item.findMany =
      async () => [];

    const turn: readonly LlmEvent[] = [
      {
        kind: "tool_call",
        call: { id: "call_x", name: "list_items", arguments: { bucket: "open" } },
      },
      { kind: "done" },
    ];
    // Same turn replayed indefinitely; cap at 3 so the test stays fast.
    const llm = new FakeLlm([turn, turn, turn, turn] as readonly (readonly LlmEvent[])[]);

    const events = await collect(
      runTurn({
        db,
        adapter: llm,
        conversationId: "conv_1",
        userId: "user_1",
        userMessage: "loop",
        readOnly: false,
        maxToolRounds: 3,
      }),
    );

    const err = events.find((e): e is { kind: "error"; message: string } => e.kind === "error");
    expect(err?.message).toMatch(/exceeded 3 tool-call rounds/);
    expect(llm.requests.length).toBe(3);
  });

  it("honors the user's chat.max-tool-rounds setting when no override is passed", async () => {
    const { db } = makeStubDb();
    (db as unknown as { item: { findMany: () => Promise<unknown[]> } }).item.findMany =
      async () => [];

    // Seed a stored user setting of 4. The catalog-default fallback is 12,
    // so this proves the loop is reading the stored row, not the default.
    (
      db as unknown as { setting: { findFirst: (args: unknown) => Promise<unknown> } }
    ).setting.findFirst = async (args: unknown) => {
      const a = args as { where?: { key?: string } } | undefined;
      if (a?.where?.key === "chat.max-tool-rounds") return { value: JSON.stringify(4) };
      return null;
    };

    const turn: readonly LlmEvent[] = [
      {
        kind: "tool_call",
        call: { id: "call_x", name: "list_items", arguments: { bucket: "open" } },
      },
      { kind: "done" },
    ];
    const llm = new FakeLlm([turn, turn, turn, turn, turn] as readonly (readonly LlmEvent[])[]);

    const events = await collect(
      runTurn({
        db,
        adapter: llm,
        conversationId: "conv_1",
        userId: "user_1",
        userMessage: "loop",
        readOnly: false,
      }),
    );

    const err = events.find((e): e is { kind: "error"; message: string } => e.kind === "error");
    expect(err?.message).toMatch(/exceeded 4 tool-call rounds/);
    expect(llm.requests.length).toBe(4);
  });

  it("surfaces an LLM error event as a final loop error and stops streaming", async () => {
    const { db, state } = makeStubDb();
    const llm = new FakeLlm([
      [
        { kind: "text_delta", delta: "partial..." },
        { kind: "error", message: "rate limit exceeded" },
      ] as readonly LlmEvent[],
    ]);

    const events = await collect(
      runTurn({
        db,
        adapter: llm,
        conversationId: "conv_1",
        userId: "user_1",
        userMessage: "go",
        readOnly: false,
      }),
    );

    expect(events.at(-1)).toEqual({ kind: "error", message: "rate limit exceeded" });
    // We still persisted the user message and a partial assistant message.
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(state.messages[1].content).toBe("partial...");
  });

  it("returns an error if the conversation does not exist", async () => {
    const { db } = makeStubDb();
    const llm = new FakeLlm([]);
    const events = await collect(
      runTurn({
        db,
        adapter: llm,
        conversationId: "nope",
        userId: "user_1",
        userMessage: "hi",
        readOnly: false,
      }),
    );
    expect(events).toEqual([{ kind: "error", message: "conversation 'nope' not found" }]);
  });
});
