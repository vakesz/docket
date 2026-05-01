import {
  BarChart3,
  Bot,
  Brain,
  Clock,
  Cpu,
  Download,
  FileText,
  FolderPlus,
  Globe,
  KeyRound,
  Lightbulb,
  ListOrdered,
  MessageSquare,
  Power,
  ScrollText,
  ServerCog,
  Shield,
  ShieldCheck,
  Sparkles,
  UserRound,
  Users,
} from "lucide-react";

export type SectionKey =
  | "memory"
  | "sources"
  | "mcp"
  | "project-llm"
  | "project-web-fetch"
  | "project-guardrail"
  | "project-auto-accept"
  | "project-recommendations"
  | "project-analytics"
  | "project-members"
  | "project-export"
  | "project-items"
  | "projects"
  | "profile"
  | "chat"
  | "items-list"
  | "item-detail"
  | "budget-audit"
  | "global-analytics"
  | "llm-providers"
  | "oauth-providers"
  | "prompts"
  | "read-only-mode";

export type SectionGroup = "project" | "you" | "deployment";

export type SectionMeta = {
  key: SectionKey;
  label: string;
  description: string;
  icon: typeof UserRound;
  group: SectionGroup;
  /** Project-scoped sections grey out when no project is active. */
  needsProject?: boolean;
};

export const SECTIONS: SectionMeta[] = [
  {
    key: "memory",
    label: "Memory",
    description: "Per-project notes the agent reads on every turn.",
    icon: Brain,
    group: "project",
    needsProject: true,
  },
  {
    key: "sources",
    label: "Sources",
    description: "Reference documents the agent can read on demand (read-only for the agent).",
    icon: FileText,
    group: "project",
    needsProject: true,
  },
  {
    key: "mcp",
    label: "MCP servers",
    description: "Model Context Protocol servers attached to this project.",
    icon: ServerCog,
    group: "project",
    needsProject: true,
  },
  {
    key: "project-llm",
    label: "LLM defaults",
    description:
      "Pick which LLM provider this project uses by default and the sampling temperature.",
    icon: Cpu,
    group: "project",
    needsProject: true,
  },
  {
    key: "project-web-fetch",
    label: "Web fetch",
    description:
      "Toggle the agent's web_fetch tool, optionally restrict it to an allowlist, and cap response size.",
    icon: Globe,
    group: "project",
    needsProject: true,
  },
  {
    key: "project-guardrail",
    label: "Guardrails",
    description:
      "Screen chat for prompt injection, off-topic requests, and unsafe output. Needs a guardrail-role LLM provider.",
    icon: ShieldCheck,
    group: "project",
    needsProject: true,
  },
  {
    key: "project-auto-accept",
    label: "Auto-accept",
    description:
      "Skip the human-in-the-loop confirm step for low-stakes proposal kinds. Off by default.",
    icon: Shield,
    group: "project",
    needsProject: true,
  },
  {
    key: "project-recommendations",
    label: "Recommendations",
    description:
      "Toggle the agent's recommendation modes (likely-resolved, duplicate detection) and tune the code-snippet caps the post-processor enforces.",
    icon: Lightbulb,
    group: "project",
    needsProject: true,
  },
  {
    key: "project-items",
    label: "Items defaults",
    description:
      "Project-level defaults for the items list — currently the staleness threshold (members can override theirs under Profile → Item detail).",
    icon: Clock,
    group: "project",
    needsProject: true,
  },
  {
    key: "project-analytics",
    label: "Analytics",
    description: "Daily LLM usage and spend for this project.",
    icon: BarChart3,
    group: "project",
    needsProject: true,
  },
  {
    key: "project-members",
    label: "Members",
    description: "Invite teammates and pick who can stage proposals or confirm them.",
    icon: Users,
    group: "project",
    needsProject: true,
  },
  {
    key: "project-export",
    label: "Export",
    description:
      "Download a JSON archive of this project's memory, sources, and your conversations.",
    icon: Download,
    group: "project",
    needsProject: true,
  },

  {
    key: "projects",
    label: "Projects",
    description: "Add another repo, switch defaults, or archive a project.",
    icon: FolderPlus,
    group: "you",
  },
  {
    key: "profile",
    label: "Profile",
    description: "Identity, theme, time zone, and dashboard polling.",
    icon: UserRound,
    group: "you",
  },
  {
    key: "items-list",
    label: "Items list",
    description:
      "Backlog filter bar defaults, row appearance, recently-viewed items, and a personal staleness override that wins over each project's value.",
    icon: ListOrdered,
    group: "you",
  },
  {
    key: "item-detail",
    label: "Item detail",
    description: "Personal toggles for what renders on the item detail page (reactions today).",
    icon: Clock,
    group: "you",
  },
  {
    key: "chat",
    label: "Chat",
    description: "Tool-call rendering, send-on-Enter, and the agent's per-turn tool-call budget.",
    icon: MessageSquare,
    group: "you",
  },

  {
    key: "budget-audit",
    label: "Budget & audit",
    description: "Monthly LLM cost cap, cap-reached behavior, and audit-row retention.",
    icon: ScrollText,
    group: "deployment",
  },
  {
    key: "global-analytics",
    label: "Analytics",
    description: "Daily LLM usage and spend across every project in this deployment.",
    icon: BarChart3,
    group: "deployment",
  },
  {
    key: "llm-providers",
    label: "LLM providers",
    description: "Vendor keys, default model, and the global fallback flag.",
    icon: Bot,
    group: "deployment",
  },
  {
    key: "oauth-providers",
    label: "OAuth providers",
    description: "Sign-in providers — NextAuth rebuilds its provider list per request from these.",
    icon: KeyRound,
    group: "deployment",
  },
  {
    key: "prompts",
    label: "Agent prompts",
    description:
      "System prompt and per-kind prefixes the agent loads on every turn. Empty fields fall back to the bundled defaults.",
    icon: Sparkles,
    group: "deployment",
  },
  {
    key: "read-only-mode",
    label: "Read-only mode",
    description:
      "Kill-switch for every mutation route — including proposal confirms. Reads stay open. Flip on for maintenance windows.",
    icon: Power,
    group: "deployment",
  },
];

export const GROUPS: { key: SectionGroup; label: string }[] = [
  { key: "project", label: "Project" },
  { key: "you", label: "You" },
  { key: "deployment", label: "Deployment" },
];

export const SECTION_STORAGE_KEY = "docket.settings.section";

export function readPersistedSection(): SectionKey | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(SECTION_STORAGE_KEY);
    if (v && SECTIONS.some((s) => s.key === v)) {
      return v as SectionKey;
    }
  } catch {
    // ignore
  }
  return null;
}
