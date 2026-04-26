/**
 * Central React Query key factory.
 *
 * Keeping every key in one place means `invalidateQueries` on a mutation can
 * reach the right cache entries without the caller having to remember the
 * tuple shape. Mirrors the backend route tree.
 */

import type { components } from "./schema";

type ItemKind = components["schemas"]["ItemKind"];
type ItemState = components["schemas"]["ItemState"];

export const qk = {
  all: ["docket"] as const,

  setupStatus: () => [...qk.all, "setup", "status"] as const,
  setupProviderTypes: () => [...qk.all, "setup", "providerTypes"] as const,

  status: () => [...qk.all, "status"] as const,
  settings: () => [...qk.all, "settings"] as const,
  settingsProviderTypes: () => [...qk.all, "settings", "providerTypes"] as const,

  providers: () => [...qk.all, "providers"] as const,
  activeProvider: () => [...qk.all, "providers", "active"] as const,
  scopes: () => [...qk.all, "scopes"] as const,
  activeScope: () => [...qk.all, "scopes", "active"] as const,

  items: (filter?: {
    kind?: ItemKind | null;
    state?: ItemState[] | null;
    tag?: string | null;
    archived?: boolean;
    parent_id?: string | null;
  }) => [...qk.all, "items", filter ?? {}] as const,
  itemSearch: (q: string, kind?: ItemKind | null, limit?: number) =>
    [...qk.all, "items", "search", q, kind ?? null, limit ?? null] as const,
  item: (id: string) => [...qk.all, "item", id] as const,
  comments: (id: string) => [...qk.all, "item", id, "comments"] as const,
  linked: (id: string) => [...qk.all, "item", id, "linked"] as const,
  conversation: (id: string) => [...qk.all, "item", id, "conversation"] as const,
  pendingQuestion: (id: string) =>
    [...qk.all, "item", id, "conversation", "pendingQuestion"] as const,

  pinned: () => [...qk.all, "pinned"] as const,
  isPinned: (id: string) => [...qk.all, "item", id, "pinned"] as const,

  prompts: () => [...qk.all, "prompts"] as const,
  prompt: (key: string) => [...qk.all, "prompts", key] as const,

  activeProject: () => [...qk.all, "projects", "active"] as const,

  mcpServers: (projectId: string) => [...qk.all, "mcp", projectId, "servers"] as const,
  mcpServer: (projectId: string, name: string) =>
    [...qk.all, "mcp", projectId, "server", name] as const,
  mcpPresets: () => [...qk.all, "mcp", "presets"] as const,

  memoryList: (projectId: string) => [...qk.all, "memory", projectId, "list"] as const,
  memoryEntry: (projectId: string, memoryId: string) =>
    [...qk.all, "memory", projectId, "entry", memoryId] as const,

  sourcesList: (projectId: string, kind?: string | null) =>
    [...qk.all, "sources", projectId, "list", kind ?? null] as const,
  sourceEntry: (projectId: string, sourceId: string) =>
    [...qk.all, "sources", projectId, "entry", sourceId] as const,
};
