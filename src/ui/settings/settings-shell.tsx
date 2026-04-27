"use client";
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
  MessageSquare,
  RefreshCw,
  ScrollText,
  ServerCog,
  Shield,
  SlidersHorizontal,
  UserRound,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { McpPane } from "@/ui/mcp/mcp-pane";
import { MemoryPane } from "@/ui/memory/memory-pane";
import { ActiveProjectPicker } from "@/ui/settings/active-project-picker";
import { AnalyticsPanel } from "@/ui/settings/analytics-panel";
import { AutoAcceptPanel } from "@/ui/settings/auto-accept-panel";
import { BudgetAuditPanel } from "@/ui/settings/budget-audit-panel";
import { ChatDisplayPanel } from "@/ui/settings/chat-display-panel";
import { ExportPanel } from "@/ui/settings/export-panel";
import { LlmProvidersPanel } from "@/ui/settings/llm-providers-panel";
import { MembersPanel } from "@/ui/settings/members-panel";
import { OauthProvidersPanel } from "@/ui/settings/oauth-providers-panel";
import { ProfilePanel } from "@/ui/settings/profile-panel";
import { ProjectLlmPanel } from "@/ui/settings/project-llm-panel";
import { ProjectsPanel } from "@/ui/settings/projects-panel";
import { SyncPanel } from "@/ui/settings/sync-panel";
import { WebFetchPanel } from "@/ui/settings/web-fetch-panel";
import { WorkspacePanel } from "@/ui/settings/workspace-panel";
import { SourcesPane } from "@/ui/sources/sources-pane";

type SectionKey =
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
  | "workspace"
  | "budget-audit"
  | "global-analytics"
  | "llm-providers"
  | "oauth-providers";
type SectionGroup = "project" | "you" | "workspace" | "deployment";

type SectionMeta = {
  key: SectionKey;
  label: string;
  description: string;
  icon: typeof UserRound;
  group: SectionGroup;
  /** Project-scoped sections grey out when no project is active. */
  needsProject?: boolean;
};

const SECTIONS: SectionMeta[] = [
  // Project — per-project context the agent uses day to day.
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

  // You — per-user preferences.
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

  // Workspace — deployment-wide knobs that aren't tied to a provider row.
  {
    key: "workspace",
    label: "Workspace",
    description: "Staleness threshold, system read-only mode, and other site-wide knobs.",
    icon: SlidersHorizontal,
    group: "workspace",
  },

  // Deployment — backends configured at install time.
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

const GROUPS: { key: SectionGroup; label: string }[] = [
  { key: "project", label: "Project" },
  { key: "you", label: "You" },
  { key: "workspace", label: "Workspace" },
  { key: "deployment", label: "Deployment" },
];

const STORAGE_KEY = "docket.settings.section";

function readPersistedSection(): SectionKey | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v && SECTIONS.some((s) => s.key === v)) {
      return v as SectionKey;
    }
  } catch {
    // ignore
  }
  return null;
}

type Props = {
  publicBase: string;
  /**
   * Active project for project-scoped sections. Resolved server-side from
   * `?project=<id>` → user's default → most recent. Null when the user
   * has no projects at all.
   */
  project: { id: string; name: string } | null;
  /**
   * Initial section to land on, set from the `?section=<key>` query param.
   * Lets external entry points (e.g. the topbar "+ Add project" button)
   * deep-link to a specific pane and override the localStorage default.
   */
  initialSection?: SectionKey;
};

/**
 * Settings shell: sidebar with grouped sections + the matching pane in
 * the main area. Mirrors main's layout (Project / You / Workspace /
 * Deployment groups) so users moving between branches find the same
 * vocabulary. Active section persists in localStorage.
 */
export function SettingsShell({ publicBase, project, initialSection }: Props) {
  const projectId = project?.id ?? null;

  // Default landing: first project section if a project is active, else
  // "profile". `null` means "uninitialized — reading localStorage in an
  // effect" so SSR and the first paint don't disagree.
  const [active, setActive] = useState<SectionKey>(
    initialSection ?? (projectId ? "memory" : "profile"),
  );

  useEffect(() => {
    if (initialSection) {
      const meta = SECTIONS.find((s) => s.key === initialSection);
      if (meta && (!meta.needsProject || projectId)) {
        setActive(initialSection);
        return;
      }
    }
    const persisted = readPersistedSection();
    if (persisted) {
      const meta = SECTIONS.find((s) => s.key === persisted);
      if (meta && (!meta.needsProject || projectId)) {
        setActive(persisted);
        return;
      }
    }
    setActive(projectId ? "memory" : "profile");
  }, [projectId, initialSection]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, active);
    } catch {
      // ignore
    }
  }, [active]);

  const grouped = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        sections: SECTIONS.filter((s) => s.group === g.key),
      })),
    [],
  );

  const activeMeta = SECTIONS.find((s) => s.key === active) ?? SECTIONS[0];
  if (!activeMeta) {
    throw new Error("settings shell rendered with empty SECTIONS list");
  }
  const blockedByMissingProject = Boolean(activeMeta.needsProject) && !projectId;

  return (
    <div className="grid min-h-0 w-full flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-auto border-b border-border bg-surface/80 px-3 py-4 lg:border-b-0 lg:border-r">
        <nav className="flex flex-col gap-4">
          {grouped.map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              <div className="px-3 pb-1 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-fg-muted">
                {group.label}
              </div>
              {group.key === "project" ? (
                <div className="px-3 pb-2">
                  <ActiveProjectPicker currentProjectId={projectId} />
                </div>
              ) : null}
              {group.sections.map((section) => {
                const Icon = section.icon;
                const isActive = section.key === active;
                const disabled = Boolean(section.needsProject) && !projectId;
                return (
                  <button
                    key={section.key}
                    type="button"
                    onClick={() => {
                      if (disabled) return;
                      setActive(section.key);
                    }}
                    disabled={disabled}
                    className={cn(
                      "flex items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors",
                      isActive ? "bg-accent/10 text-accent" : "text-fg hover:bg-surface-alt",
                      disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                    )}
                    title={disabled ? "Pick a project above to enable" : undefined}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1 truncate font-medium">{section.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      <section className="min-h-0 overflow-auto">
        <header className="border-b border-border bg-surface/70 px-6 py-4 backdrop-blur">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-lg font-semibold text-fg">{activeMeta.label}</h2>
            {activeMeta.needsProject && project ? (
              <span className="rounded-full border border-border bg-surface-alt px-2 py-0.5 text-[11px] uppercase tracking-wide text-fg-muted">
                {project.name}
              </span>
            ) : null}
          </div>
          <p className="mt-1 max-w-3xl text-sm text-fg-muted">{activeMeta.description}</p>
        </header>

        <div className="px-6 py-6">
          {blockedByMissingProject ? (
            <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-center text-sm text-fg-muted">
              Pick a project from the sidebar to manage its {activeMeta.label.toLowerCase()}.
            </p>
          ) : (
            <SectionContent active={active} projectId={projectId} publicBase={publicBase} />
          )}
        </div>
      </section>
    </div>
  );
}

function SectionContent({
  active,
  projectId,
  publicBase,
}: {
  active: SectionKey;
  projectId: string | null;
  publicBase: string;
}) {
  switch (active) {
    case "memory":
      return projectId ? <MemoryPane projectId={projectId} /> : null;
    case "sources":
      return projectId ? <SourcesPane projectId={projectId} /> : null;
    case "mcp":
      return projectId ? <McpPane projectId={projectId} /> : null;
    case "project-llm":
      return projectId ? <ProjectLlmPanel projectId={projectId} /> : null;
    case "project-web-fetch":
      return projectId ? <WebFetchPanel projectId={projectId} /> : null;
    case "project-auto-accept":
      return projectId ? <AutoAcceptPanel projectId={projectId} /> : null;
    case "project-sync":
      return projectId ? <SyncPanel projectId={projectId} /> : null;
    case "project-analytics":
      return projectId ? <AnalyticsPanel scope="project" projectId={projectId} /> : null;
    case "project-members":
      return projectId ? <MembersPanel projectId={projectId} /> : null;
    case "project-export":
      return projectId ? <ExportPanel projectId={projectId} /> : null;
    case "projects":
      return <ProjectsPanel />;
    case "profile":
      return <ProfilePanel />;
    case "chat":
      return <ChatDisplayPanel />;
    case "workspace":
      return <WorkspacePanel />;
    case "budget-audit":
      return <BudgetAuditPanel />;
    case "global-analytics":
      return <AnalyticsPanel scope="global" />;
    case "llm-providers":
      return <LlmProvidersPanel />;
    case "oauth-providers":
      return <OauthProvidersPanel publicBase={publicBase} />;
  }
}
