import {
  BarChart3,
  Bot,
  Brain,
  Cpu,
  Download,
  FileText,
  FolderPlus,
  Globe,
  KeyRound,
  LineChart,
  ListOrdered,
  MessageSquare,
  RefreshCw,
  ScrollText,
  ServerCog,
  Shield,
  SlidersHorizontal,
  UserRound,
  Users,
} from "lucide-react";

export type SectionKey =
  | "memory"
  | "sources"
  | "mcp"
  | "project-llm"
  | "project-web-fetch"
  | "project-auto-accept"
  | "project-sync"
  | "project-analytics"
  | "project-members"
  | "project-export"
  | "projects"
  | "profile"
  | "chat"
  | "items-display"
  | "workspace"
  | "budget-audit"
  | "global-analytics"
  | "llm-providers"
  | "oauth-providers";

export type SectionGroup = "project" | "you" | "workspace" | "deployment";

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
    key: "project-auto-accept",
    label: "Auto-accept",
    description:
      "Skip the human-in-the-loop confirm step for low-stakes proposal kinds. Off by default.",
    icon: Shield,
    group: "project",
    needsProject: true,
  },
  {
    key: "project-sync",
    label: "Sync",
    description:
      "Refresh the cached items from the provider, or run a full walk to reconcile archived items.",
    icon: RefreshCw,
    group: "project",
    needsProject: true,
  },
  {
    key: "project-analytics",
    label: "Analytics",
    description: "Daily LLM usage and spend for this project.",
    icon: LineChart,
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
    description: "Default project and chat send-key.",
    icon: UserRound,
    group: "you",
  },
  {
    key: "chat",
    label: "Chat",
    description: "How tool calls render in the chat pane.",
    icon: MessageSquare,
    group: "you",
  },
  {
    key: "items-display",
    label: "Items pane",
    description: "Browser-local layout knobs for the backlog list — recents count, etc.",
    icon: ListOrdered,
    group: "you",
  },

  {
    key: "workspace",
    label: "Workspace",
    description: "Staleness threshold, system read-only mode, and other site-wide knobs.",
    icon: SlidersHorizontal,
    group: "workspace",
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
];

export const GROUPS: { key: SectionGroup; label: string }[] = [
  { key: "project", label: "Project" },
  { key: "you", label: "You" },
  { key: "workspace", label: "Workspace" },
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
