import type { ComponentType } from "react";

export type ConfigMap = Record<string, unknown>;

export type Mode = "form" | "raw";

export type SectionKey =
  | "providers"
  | "llm"
  | "http"
  | "ui"
  | "telemetry"
  | "sync"
  | "stale"
  | "prompts"
  | "mcp"
  | "memory"
  | "sources";

/** Sections that own their own editor and are not backed by `config.toml`.
 * They opt out of the form/raw mode switch, dirty-patch tracking, and the
 * shared ⌘S save shortcut. Add new virtual sections here when registering
 * them. */
export const VIRTUAL_SECTIONS = new Set<SectionKey>(["prompts", "mcp", "memory", "sources"]);

export type SectionGroup = "project" | "workspace" | "cache" | "app";

export const SECTION_GROUPS: { key: SectionGroup; label: string }[] = [
  { key: "project", label: "Project" },
  { key: "workspace", label: "Workspace" },
  { key: "cache", label: "Cache" },
  { key: "app", label: "App" },
];

export type SectionMeta = {
  key: SectionKey;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  requiresRestart: boolean;
  group: SectionGroup;
};
