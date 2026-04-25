import {
  Activity,
  Bot,
  Clock,
  Globe,
  Palette,
  RefreshCw,
  Server,
  ServerCog,
  Sparkles,
} from "lucide-react";

import type { SectionMeta } from "./_types";

export const SECTIONS: SectionMeta[] = [
  {
    key: "providers",
    label: "Providers",
    description: "Configured backends and the active provider used at startup.",
    icon: Server,
    requiresRestart: true,
  },
  {
    key: "llm",
    label: "LLM",
    description: "Chat model, endpoint, and assistant loop tuning.",
    icon: Bot,
    requiresRestart: true,
  },
  {
    key: "http",
    label: "HTTP",
    description: "Local API surface, bind address, and bearer token.",
    icon: Globe,
    requiresRestart: true,
  },
  {
    key: "ui",
    label: "Interface",
    description: "Theme, default item kind, and UI presentation.",
    icon: Palette,
    requiresRestart: false,
  },
  {
    key: "telemetry",
    label: "Telemetry",
    description: "Anonymous diagnostics and runtime instrumentation.",
    icon: Activity,
    requiresRestart: false,
  },
  {
    key: "sync",
    label: "Sync",
    description: "Background refresh cadence and per-provider floors.",
    icon: RefreshCw,
    requiresRestart: true,
  },
  {
    key: "stale",
    label: "Staleness",
    description: "How long cached items can sit before being marked stale.",
    icon: Clock,
    requiresRestart: false,
  },
  {
    key: "prompts",
    label: "Prompts",
    description: "Edit the markdown prompt templates the agent uses.",
    icon: Sparkles,
    requiresRestart: false,
  },
  {
    key: "mcp",
    label: "MCP servers",
    description: "Manage Model Context Protocol servers attached to the active project.",
    icon: ServerCog,
    requiresRestart: false,
  },
];

export const ITEM_KINDS = ["epic", "feature", "story", "task", "bug"] as const;

// Mirrors Textual's built-in available_themes keys (+ the meta "system"
// sentinel the TUI treats as "follow OS"). The Select allows custom entries so
// a user can point at a theme registered by a future plugin.
export const THEME_OPTIONS = [
  "system",
  "textual-dark",
  "textual-light",
  "textual-ansi",
  "nord",
  "gruvbox",
  "catppuccin-mocha",
  "catppuccin-latte",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "dracula",
  "tokyo-night",
  "monokai",
  "flexoki",
  "solarized-light",
  "solarized-dark",
  "rose-pine",
  "rose-pine-moon",
  "rose-pine-dawn",
  "atom-one-dark",
  "atom-one-light",
] as const;

export const LOG_LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] as const;

export const MODE_STORAGE_KEY = "docket.settings.mode";

export const readOnlyFieldClass =
  "rounded-xl border border-border bg-surface-alt px-3 py-2 font-mono text-sm text-fg-muted";
