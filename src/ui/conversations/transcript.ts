/**
 * Pure transcript helpers shared across chat-pane subcomponents. Lives
 * outside any React component so it stays trivial to unit-test and the
 * surrounding "use client" islands don't grow when these are imported.
 */

import { extractSeedKind, type SeedKind } from "@/ui/items/suggest-seeds";

export type PersistedMessage = {
  id: string;
  role: string;
  content: string;
  toolName: string | null;
  toolCallId: string | null;
  toolCallsJson: unknown;
};

export type AssistantToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type RenderUnit =
  | { kind: "text"; key: string; role: string; content: string; seedKind: SeedKind | null }
  | {
      kind: "tool_call";
      key: string;
      toolCallId: string | null;
      name: string;
      arguments: Record<string, unknown> | null;
      result: string;
      ok: boolean | null;
    };

export function condenseArgs(args: Record<string, unknown> | null, maxLen = 100): string {
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

export function safeStringify(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable]";
  }
}

export function parseAssistantToolCalls(raw: unknown): AssistantToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: AssistantToolCall[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e["id"] === "string" ? e["id"] : null;
    const name = typeof e["name"] === "string" ? e["name"] : null;
    const args =
      e["arguments"] && typeof e["arguments"] === "object"
        ? (e["arguments"] as Record<string, unknown>)
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
export function buildRenderUnits(messages: readonly PersistedMessage[]): RenderUnit[] {
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
        units.push({
          kind: "text",
          key: `${m.id}:text`,
          role: m.role,
          content: m.content,
          seedKind: null,
        });
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
    units.push({
      kind: "text",
      key: `${m.id}:text`,
      role: m.role,
      content: m.content,
      seedKind: m.role === "user" ? extractSeedKind(m.content) : null,
    });
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
