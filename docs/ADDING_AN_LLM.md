# Adding an LLM Vendor to Docket

This guide walks through wiring a new chat-style LLM vendor (Anthropic,
Gemini, Bedrock, Ollama, anything else) into Docket without touching the
agent loop, the prompt builder, the tool registry, or any UI surface. The
pattern is **strictly additive** — every consumer talks to the
vendor-neutral `LlmAdapter` interface, so a new sibling adapter file plus
two registry edits is enough.

If you find yourself editing `src/agent/loop.ts`, `src/agent/prompt.ts`,
`src/agent/tools/`, or `src/server/<feature>/router.ts` to land an LLM
vendor, stop and re-read this — that's a leak the arch tests under
`src/__arch__/` exist to catch.

---

## 1. New adapter or new row?

Two flavors of "add an LLM," easy to confuse:

| You want… | Do |
| --- | --- |
| Use an existing wired vendor (e.g. another OpenAI-compatible endpoint, an Azure AI Foundry deployment, a self-hosted Ollama proxy that speaks the OpenAI API). | **Add a row** in Settings → LLM providers. No code changes. |
| Add support for a vendor whose API doesn't already have a wired adapter (Anthropic, Gemini, Bedrock, Cohere, …). | **Add an adapter** (this guide). |

The OpenAI adapter handles every endpoint that speaks the OpenAI Responses
API — that includes Azure AI Foundry, vLLM, Ollama's OpenAI-compatible
mode, LiteLLM proxies, and OpenRouter. Set `baseUrl` on the row. Only
reach for a new adapter when the wire format itself is different.

---

## 2. The vendor-neutral contract

The agent loop and the guardrail pipeline never import a vendor SDK
directly. They only see `LlmAdapter` values handed in by
`selectAdapterFor(project)` (chat) or `selectGuardrailFor(project)`
(guardrail). The interface lives in `src/agent/llm/types.ts`:

```ts
export interface LlmAdapter {
  readonly kind: LlmKind;
  readonly label: string;

  // Stream a chat completion. MUST yield exactly one `{ kind: "done" }`
  // or `{ kind: "error" }` as the final event.
  streamMessages(req: LlmRequest): AsyncIterable<LlmEvent>;

  // Build the next-turn `tool` message from a tool's structured result.
  // Vendor-specific quirks (id naming, ordering) stay on the adapter.
  formatToolResult(call: LlmToolCall, result: unknown): LlmToolResult;
}
```

Both `LlmRequest` and `LlmEvent` are defined in the same file. `LlmRequest`
is one round-trip: `model`, ordered `messages` (system + transcript),
`tools` (already in JSON Schema — every major vendor converged), optional
`temperature`, `maxOutputTokens`, and `signal`. `LlmEvent` is what the loop
consumes:

- `text_delta` — assistant text token(s)
- `tool_call` — assistant requested a tool; the loop dispatches and
  re-feeds the tool result on the next turn
- `usage` — token / cost accounting; emit at most once per turn
- `done` — adapter finished this turn (assistant message complete)
- `error` — adapter-fatal; loop aborts the turn and surfaces the message

Tools are pre-translated into JSON Schema by the agent — no per-vendor
tool wrapping at the call site. Honor `signal` so a cancelled browser
request stops billing the LLM.

---

## 3. Vendor SDK quarantine

This is the single most important rule:

**A vendor SDK may only be imported from its adapter file (and the
guardrail LLM-judge if it shares the SDK).**

The arch test `src/__arch__/no-llm-vendor-leak.test.ts` enforces it. The
quarantine list reads (one entry per SDK):

```ts
const QUARANTINES: Quarantine[] = [
  {
    sdk: "openai",
    allowedFiles: [
      join("src", "agent", "llm", "openai.ts"),
      join("src", "agent", "guardrail", "llm-judge.ts"),
    ],
    matcher: /from\s+["']openai…/,
  },
  {
    sdk: "@anthropic-ai/sdk",
    allowedFiles: [join("src", "agent", "llm", "anthropic.ts")],
    matcher: /from\s+["']@anthropic-ai\/sdk…/,
  },
];
```

When you add a new vendor, append a `Quarantine` entry: list the SDK
package, the adapter file as the sole allowed importer (plus
`llm-judge.ts` if the guardrail will reuse the same SDK), and a regex
matcher for `from "<pkg>"`. If you skip this entry, the test will not
catch a future leak.

The reason the rule is this strict: every UI surface, the agent loop, the
tool registry, the prompt builder, and the chat SSE handler all talk to
`LlmAdapter`. A vendor SDK leaking outside its file means the next vendor
lands as a multi-file diff instead of a single sibling adapter.

---

## 4. Package layout

Adapters live under `src/agent/llm/`. The canonical layout (mirrors
`openai.ts`):

```text
src/agent/llm/
├── types.ts          # LlmAdapter, LlmRequest, LlmEvent — vendor-neutral
├── registry.ts       # selectAdapterFor + buildAdapter dispatch
├── openai.ts         # OpenAI adapter (the only file allowed to `import "openai"`)
└── <vendor>.ts       # ← your new adapter
```

One file per vendor. Translate vendor-native event shapes into `LlmEvent`
inside the adapter; the rest of the tree never sees the SDK's types.

---

## 5. Implement the adapter

The interface is small. Lift the OpenAI adapter as a starting point and
swap the SDK calls. Required behaviors:

1. **One terminal event.** `streamMessages` MUST yield exactly one
   `{ kind: "done" }` or `{ kind: "error" }` as the final event. The loop
   relies on this to close the SSE stream.
2. **Forward `signal`.** Pass the abort signal to the SDK's request so
   cancelled browser requests stop billing.
3. **Translate tool calls.** When the model emits a tool call, yield
   `{ kind: "tool_call", call }` with `call.arguments` already parsed
   into a plain object — the loop never re-parses.
4. **Implement `formatToolResult`.** This is what the next turn's
   `tool`-role message looks like. OpenAI uses `tool_call_id`; Anthropic
   uses a different shape entirely. Encapsulate the difference here.
5. **Emit usage when you can.** If the SDK reports token counts and the
   `LlmProvider` row carries `inputPriceCentsPerMtok` /
   `outputPriceCentsPerMtok`, compute USD-cent cost and yield
   `{ kind: "usage", tokensIn, tokensOut, costCents }` once per turn.
   Without prices, leave `costCents` undefined and budget tracking
   silently undercounts that turn.
6. **Default the model.** The adapter should accept `model` from the
   constructor and fall back to a sensible default
   (`anthropic` → `claude-sonnet-4-6`, `gemini` → `gemini-2.5-pro`, etc.).
   The `LlmProvider.model` row override always wins.

```ts
// src/agent/llm/anthropic.ts
import Anthropic from "@anthropic-ai/sdk";
import type { LlmAdapter, LlmEvent, LlmRequest, LlmToolCall, LlmToolResult } from "@/agent/llm/types";

export type AnthropicAdapterConfig = {
  apiKey: string;
  label: string;
  model?: string;
  baseUrl?: string;
  defaultTemperature?: number;
  inputPriceCentsPerMtok?: number | null;
  outputPriceCentsPerMtok?: number | null;
};

export class AnthropicAdapter implements LlmAdapter {
  readonly kind = "anthropic" as const;
  readonly label: string;
  private readonly client: Anthropic;
  // …

  constructor(config: AnthropicAdapterConfig) { /* … */ }

  async *streamMessages(req: LlmRequest): AsyncIterable<LlmEvent> {
    // 1. Translate req.messages + req.tools into the SDK shape
    // 2. Open the streaming call, forwarding req.signal
    // 3. Map vendor events → LlmEvent, yielding text_delta / tool_call / usage
    // 4. Yield exactly one done/error
  }

  formatToolResult(call: LlmToolCall, result: unknown): LlmToolResult {
    // Encapsulate vendor-specific tool-result shape here
  }
}
```

---

## 6. Register the kind

Two edits, both in `src/agent/llm/`:

**`types.ts`** — add the kind to `LLM_KINDS` and a label:

```ts
export const LLM_KINDS = ["openai", "anthropic"] as const;

export const LLM_KIND_LABELS: Record<LlmKind, string> = {
  openai: "OpenAI / OpenAI-compatible",
  anthropic: "Anthropic",
};
```

**`registry.ts`** — add a `case` to `buildAdapter`:

```ts
import { AnthropicAdapter } from "@/agent/llm/anthropic";

export function buildAdapter(row: LlmProvider, opts = {}): LlmAdapter {
  const apiKey = decryptSecret(row.apiKey);
  switch (row.kind) {
    case "openai":
      return new OpenAiAdapter({ /* … */ });
    case "anthropic":
      return new AnthropicAdapter({
        apiKey,
        label: row.label,
        ...(row.model ? { model: row.model } : {}),
        ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
        ...(opts.defaultTemperature != null ? { defaultTemperature: opts.defaultTemperature } : {}),
        inputPriceCentsPerMtok: row.inputPriceCentsPerMtok?.toNumber() ?? null,
        outputPriceCentsPerMtok: row.outputPriceCentsPerMtok?.toNumber() ?? null,
      });
    default:
      throw new LlmConfigError(`Unsupported LLM kind '${row.kind}'.`);
  }
}
```

The arch test `src/__arch__/llm-kinds-have-adapters.test.ts` enforces that
every `LLM_KINDS` entry has a matching `case` here. Skipping the second
edit is a CI failure, not a runtime crash later.

The UI selector under `/settings` → LLM providers reads `LLM_KIND_LABELS`
directly, so the new kind appears in the form picker as soon as the
`types.ts` edit lands.

---

## 7. Role split: chat vs guardrail

Every `LlmProvider` row carries a `role`: either `"chat"` or
`"guardrail"`. The two resolvers are disjoint:

- **Chat** (`src/agent/llm/registry.ts:selectAdapterFor`) — drives the
  agent loop. Resolution order:
  1. `Conversation.llmProviderIdOverride` (per-conversation pick)
  2. `Project.defaultLlmProviderId` (per-project pick)
  3. `role='chat' AND isDefault=true` (deployment-wide chat default)
  4. Most-recent enabled `role='chat'` row (graceful fallback)

  Every level filters `role: 'chat' AND enabled: true`. A guardrail row
  can never resolve here.

- **Guardrail** (`src/agent/guardrail/registry.ts:selectGuardrailFor`) —
  drives the LLM-judge guardrail. Resolution order:
  1. `Project.defaultGuardrailProviderId` (per-project pick)
  2. `role='guardrail' AND isDefault=true`
  3. Most-recent enabled `role='guardrail'` row

  When the guardrail kind is `llm-judge` or `composite` and no guardrail
  provider row resolves, the pipeline falls back to `pattern` and logs.

The chat path (`buildAdapter`) dispatches on `kind`, so adding a vendor
to that switch makes it instantly usable as a chat row. The guardrail
path is **not** unified yet: `LlmJudgeGuardrail` (`src/agent/guardrail/llm-judge.ts`)
imports the OpenAI SDK directly and ignores `row.kind`. That's fine for
OpenAI-compatible endpoints (Azure Foundry, Ollama, vLLM, OpenRouter,
LiteLLM) — the OpenAI SDK against a compatible base URL just works.
Vendors whose wire format differs (Anthropic Messages API, Bedrock
native, Vertex's `generateContent`) need an extra step before they can
serve as guardrail rows: extend `llm-judge.ts` to dispatch on
`row.kind`, or build a sibling guardrail adapter and update
`tryBuildLlmJudge` to pick between them. The arch test in
`no-llm-vendor-leak.test.ts` permits `llm-judge.ts` to import the OpenAI
SDK only — pull in another vendor SDK there and you'll need to
allow-list it in that test too.

Until that extension lands, treat a non-OpenAI-compatible vendor as a
chat-role-only adapter and pin a different guardrail row (or use the
`pattern` kind, which needs no provider row).

---

## 8. Encryption at rest

`LlmProvider.apiKey` is encrypted at rest with `SECRETS_KEY` using
AES-256-GCM. Wire format `enc:v1:<iv>:<ct+tag>`. Implementation in
`src/server/secrets/encryption.ts`.

`buildAdapter` calls `decryptSecret(row.apiKey)` for you — the adapter
constructor receives plaintext. Never persist or log the decrypted key.

Legacy plaintext rows (from before encryption was wired) decrypt to
themselves; the next write re-encrypts. Rotating `SECRETS_KEY` requires
re-encrypting every row that uses it — there is no transparent rotation
path today.

---

## 9. Pricing

`LlmProvider.inputPriceCentsPerMtok` and `outputPriceCentsPerMtok` are
USD cents per million tokens, stored as `Decimal`. The adapter receives
them as `number | null` and uses them to compute `costCents` for the
`usage` event. Without prices, cost is undefined and the budget tracking
silently undercounts that turn.

Fill in prices when adding a model row. The OAuth-providers panel under
`/settings` exposes the fields; the bootstrap seed accepts
`DEV_OPENAI_INPUT_PRICE_CENTS_PER_MTOK` /
`DEV_OPENAI_OUTPUT_PRICE_CENTS_PER_MTOK` for the dev seed.

---

## 10. Prompt cache invariants (read this before shipping)

The OpenAI adapter benefits from automatic prompt caching when the
request prefix is byte-stable. Other vendors take different shapes —
Anthropic uses explicit `cache_control` breakpoints, Bedrock has its
own — but byte-stability is the broadest precondition: every cache
mechanism we've seen rewards it, none penalize it.

Two invariants the rest of the system protects, and that your adapter
must not undermine:

1. **Byte-stable prefix.** No timestamps, usernames, view labels, or
   other runtime-only text in the system + ticket-snapshot prefix. The
   prefix is built in `src/agent/prompt.ts` and passed through
   `src/agent/loop.ts`. Per-turn dynamic content (recent messages, tool
   results) lives *after* the prefix.
2. **Stable tool order.** The ordered tool schema list in
   `src/agent/tools/registry.ts:TOOL_ORDER` is part of the cache key.
   Reordering invalidates every open conversation's prompt cache. Pinned
   by `src/__arch__/tool-registration-order.test.ts`.

Your adapter receives `req.messages` and `req.tools` already in the
canonical order. Don't reshuffle them, don't inject a per-request
greeting, don't normalize. Pass them through.

If your vendor wants explicit cache breakpoints (Anthropic-style), add
them inside the adapter — that's a vendor concern. The agent stays
oblivious.

---

## 11. Testing checklist

- [ ] **Adapter unit test.** Cover the happy path (text → tool_call →
      tool_result → text → done) plus an error path. Mock the SDK at the
      module boundary, not by stubbing internal helpers.
- [ ] **Arch test passes.**
      `pnpm test src/__arch__/no-llm-vendor-leak.test.ts` — confirms your
      SDK isn't imported anywhere outside the adapter file. If you didn't
      append a `Quarantine` entry, the test won't actually check your
      package; verify the offender list at the bottom of the file.
- [ ] **Registry alignment.**
      `pnpm test src/__arch__/llm-kinds-have-adapters.test.ts` — fails if
      you added the kind to `LLM_KINDS` without a matching `case`.
- [ ] **Tool-order stable.**
      `pnpm test src/__arch__/tool-registration-order.test.ts` — should
      already pass; if it doesn't, you somehow touched tool registration
      while wiring an LLM. Revert that.
- [ ] **Full check.** `pnpm check` — biome + tsc + vitest.

---

## 12. End-to-end verification

```bash
pnpm check                       # biome + tsc + vitest run
pnpm dev                         # next dev (Turbopack) + auto-seed
```

Then through the UI:

1. Visit `/settings` → LLM providers and add a new row for your kind.
   Fill in `apiKey`, optional `baseUrl`, optional `model`, prices.
2. Mark it the chat default (or assign it to a project under
   Settings → Projects).
3. Open an item and start a chat — the new adapter should drive the
   stream end-to-end (text deltas, tool calls, tool results, done).
4. (Optional) Add a second row with `role='guardrail'`, set the project's
   guardrail kind to `llm-judge`, and verify the guardrail pipeline
   picks up the new adapter.

If a chat turn errors out with `Unsupported LLM kind '<your-kind>'`, the
registry switch is missing the `case`. If it errors out with
`No LLM provider configured`, the row didn't resolve — check `enabled`,
the role filter, and the project's pin.

---

## Reference

- `src/agent/llm/types.ts` — `LlmAdapter`, `LlmRequest`, `LlmEvent`,
  `LLM_KINDS`, `LLM_KIND_LABELS`.
- `src/agent/llm/registry.ts` — `selectAdapterFor`, `buildAdapter`,
  resolution order.
- `src/agent/llm/openai.ts` — reference adapter; lift its shape.
- `src/agent/guardrail/registry.ts` — `selectGuardrailFor`, role split,
  fallback rules.
- `src/agent/guardrail/llm-judge.ts` — second allowed importer of the
  OpenAI SDK; precedent for sharing an SDK between chat and guardrail.
- `src/__arch__/no-llm-vendor-leak.test.ts` — quarantine enforcement.
- `src/__arch__/llm-kinds-have-adapters.test.ts` — registry alignment.
- `src/server/secrets/encryption.ts` — `enc:v1:<iv>:<ct+tag>` wire format.
