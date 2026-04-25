import type { DTO } from "~/api/client";

export interface McpServerDraft {
  name: string;
  command: string;
  args: string; // whitespace-separated; split on submit
  env: { key: string; value: string }[];
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

export function serializeDraft(
  draft: McpServerDraft,
): Omit<DTO["MCPServerCreateRequest"], "name"> & { name?: string } {
  const env: Record<string, string> = {};
  for (const { key, value } of draft.env) {
    const k = key.trim();
    if (!k) continue;
    env[k] = value;
  }
  return {
    name: draft.name.trim(),
    command: draft.command.trim(),
    args: parseArgs(draft.args),
    env,
    transport: draft.transport || "stdio",
    enabled: draft.enabled,
    startup_timeout_seconds: draft.startup_timeout_seconds,
  };
}
