import type { DTO } from "~/api/client";

export interface McpServerDraft {
  name: string;
  command: string;
  args: string; // whitespace-separated; split on submit
  env: { key: string; value: string }[];
  url: string;
  headers: { key: string; value: string }[];
  transport: string;
  enabled: boolean;
  startup_timeout_seconds: number;
}

export function blankDraft(): McpServerDraft {
  return {
    name: "",
    command: "",
    args: "",
    env: [],
    url: "",
    headers: [],
    transport: "stdio",
    enabled: true,
    startup_timeout_seconds: 10,
  };
}

export function draftFromServer(server: DTO["MCPServerDTO"]): McpServerDraft {
  return {
    name: server.name,
    command: server.command ?? "",
    args: (server.args ?? []).join(" "),
    env: Object.entries(server.env ?? {}).map(([key, value]) => ({ key, value })),
    url: server.url ?? "",
    headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({ key, value })),
    transport: server.transport ?? "stdio",
    enabled: server.enabled ?? true,
    startup_timeout_seconds: server.startup_timeout_seconds ?? 10,
  };
}

/** Split args on any whitespace, dropping empty tokens. We intentionally do
 * not support shell-quoting — the TUI and CLI are the same way. If you need
 * a literal space in an argument, use the env map or wrap the value in
 * `sh -c`. */
function parseArgs(raw: string): string[] {
  return raw.split(/\s+/u).filter((p) => p.length > 0);
}

function pairsEqual(
  a: { key: string; value: string }[],
  b: { key: string; value: string }[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i];
    const rb = b[i];
    if (!ra || !rb || ra.key !== rb.key || ra.value !== rb.value) return false;
  }
  return true;
}

export function draftsEqual(a: McpServerDraft, b: McpServerDraft): boolean {
  if (
    a.name !== b.name ||
    a.command !== b.command ||
    a.args !== b.args ||
    a.url !== b.url ||
    a.transport !== b.transport ||
    a.enabled !== b.enabled ||
    a.startup_timeout_seconds !== b.startup_timeout_seconds
  ) {
    return false;
  }
  return pairsEqual(a.env, b.env) && pairsEqual(a.headers, b.headers);
}

function pairsToRecord(pairs: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    const k = key.trim();
    if (!k) continue;
    out[k] = value;
  }
  return out;
}

export function serializeDraft(draft: McpServerDraft): DTO["MCPServerEntry"] {
  const transport = draft.transport || "stdio";
  // Mirror `mcp_service.validate_entry`: stdio drops url/headers, http/sse
  // drops command/args/env. Sending the empty side back would just round-trip
  // through the backend and get cleared, but it's tidier to send the canonical
  // shape.
  if (transport === "stdio") {
    return {
      command: draft.command.trim(),
      args: parseArgs(draft.args),
      env: pairsToRecord(draft.env),
      url: "",
      headers: {},
      transport,
      enabled: draft.enabled,
      startup_timeout_seconds: draft.startup_timeout_seconds,
    };
  }
  return {
    command: "",
    args: [],
    env: {},
    url: draft.url.trim(),
    headers: pairsToRecord(draft.headers),
    transport,
    enabled: draft.enabled,
    startup_timeout_seconds: draft.startup_timeout_seconds,
  };
}
