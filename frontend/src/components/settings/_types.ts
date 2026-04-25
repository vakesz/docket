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
  | "mcp";

export type SectionMeta = {
  key: SectionKey;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  requiresRestart: boolean;
};
