"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/ui/primitives/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/ui/primitives/sheet";
import {
  readPersistedSection,
  SECTION_STORAGE_KEY,
  SECTIONS,
  type SectionKey,
} from "@/ui/settings/sections";
import { SettingsSidebar } from "@/ui/settings/settings-sidebar";
import { useRegisterSidebarMount, useSidebarDrawer } from "@/ui/shell/sidebar-drawer-context";

// Each pane is lazy-loaded so the initial settings JS bundle stays light —
// only the one selected pane (and its tRPC dependencies) ships per session.
const panelLoading = () => <p className="text-muted-foreground/70 text-sm">Loading…</p>;
const McpPane = dynamic(() => import("@/ui/mcp/mcp-pane").then((m) => m.McpPane), {
  loading: panelLoading,
});
const MemoryPane = dynamic(() => import("@/ui/memory/memory-pane").then((m) => m.MemoryPane), {
  loading: panelLoading,
});
const AgentBehaviorPanel = dynamic(
  () => import("@/ui/settings/agent-behavior-panel").then((m) => m.AgentBehaviorPanel),
  { loading: panelLoading },
);
const AnalyticsPanel = dynamic(
  () => import("@/ui/settings/analytics-panel").then((m) => m.AnalyticsPanel),
  { loading: panelLoading },
);
const BudgetAuditPanel = dynamic(
  () => import("@/ui/settings/budget-audit-panel").then((m) => m.BudgetAuditPanel),
  { loading: panelLoading },
);
const ChatDisplayPanel = dynamic(
  () => import("@/ui/settings/chat-display-panel").then((m) => m.ChatDisplayPanel),
  { loading: panelLoading },
);
const ExportPanel = dynamic(() => import("@/ui/settings/export-panel").then((m) => m.ExportPanel), {
  loading: panelLoading,
});
const GuardrailPanel = dynamic(
  () => import("@/ui/settings/guardrail-panel").then((m) => m.GuardrailPanel),
  { loading: panelLoading },
);
const ItemDetailPanel = dynamic(
  () => import("@/ui/settings/item-detail-panel").then((m) => m.ItemDetailPanel),
  { loading: panelLoading },
);
const ItemsListPanel = dynamic(
  () => import("@/ui/settings/items-list-panel").then((m) => m.ItemsListPanel),
  { loading: panelLoading },
);
const LlmProvidersPanel = dynamic(
  () => import("@/ui/settings/llm-providers-panel").then((m) => m.LlmProvidersPanel),
  { loading: panelLoading },
);
const MembersPanel = dynamic(
  () => import("@/ui/settings/members-panel").then((m) => m.MembersPanel),
  { loading: panelLoading },
);
const OauthProvidersPanel = dynamic(
  () => import("@/ui/settings/oauth-providers-panel").then((m) => m.OauthProvidersPanel),
  { loading: panelLoading },
);
const ProfilePanel = dynamic(
  () => import("@/ui/settings/profile-panel").then((m) => m.ProfilePanel),
  { loading: panelLoading },
);
const ProjectItemsPanel = dynamic(
  () => import("@/ui/settings/project-items-panel").then((m) => m.ProjectItemsPanel),
  { loading: panelLoading },
);
const ProjectLlmPanel = dynamic(
  () => import("@/ui/settings/project-llm-panel").then((m) => m.ProjectLlmPanel),
  { loading: panelLoading },
);
const ProjectsPanel = dynamic(
  () => import("@/ui/settings/projects-panel").then((m) => m.ProjectsPanel),
  { loading: panelLoading },
);
const PromptsPanel = dynamic(
  () => import("@/ui/settings/prompts-panel").then((m) => m.PromptsPanel),
  { loading: panelLoading },
);
const ReadOnlyModePanel = dynamic(
  () => import("@/ui/settings/read-only-mode-panel").then((m) => m.ReadOnlyModePanel),
  { loading: panelLoading },
);
const WebFetchPanel = dynamic(
  () => import("@/ui/settings/web-fetch-panel").then((m) => m.WebFetchPanel),
  { loading: panelLoading },
);
const SourcesPane = dynamic(() => import("@/ui/sources/sources-pane").then((m) => m.SourcesPane), {
  loading: panelLoading,
});

type Props = {
  publicBase: string;
  /**
   * Active project for project-scoped sections. Resolved server-side from
   * `?project=<slug>` → user's default → most recent. Null when the user
   * has no projects at all. The CUID is kept for legacy resolution but
   * panels are addressed by slug.
   */
  project: { id: string; slug: string; name: string } | null;
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
  const projectSlug = project?.slug ?? null;

  const [active, setActive] = useState<SectionKey>(
    initialSection ?? (projectSlug ? "memory" : "profile"),
  );
  useRegisterSidebarMount();
  const { open: mobileNavOpen, setOpen: setMobileNavOpen } = useSidebarDrawer();

  useEffect(() => {
    if (initialSection) {
      const meta = SECTIONS.find((s) => s.key === initialSection);
      if (meta && (!meta.needsProject || projectSlug)) {
        setActive(initialSection);
        return;
      }
    }
    const persisted = readPersistedSection();
    if (persisted) {
      const meta = SECTIONS.find((s) => s.key === persisted);
      if (meta && (!meta.needsProject || projectSlug)) {
        setActive(persisted);
        return;
      }
    }
    setActive(projectSlug ? "memory" : "profile");
  }, [projectSlug, initialSection]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(SECTION_STORAGE_KEY, active);
    } catch {
      // ignore
    }
  }, [active]);

  const activeMeta = SECTIONS.find((s) => s.key === active) ?? SECTIONS[0];
  if (!activeMeta) {
    throw new Error("settings shell rendered with empty SECTIONS list");
  }
  const blockedByMissingProject = Boolean(activeMeta.needsProject) && !projectSlug;

  const handleSelect = (key: SectionKey) => {
    setActive(key);
    setMobileNavOpen(false);
  };

  return (
    <div className="grid min-h-0 w-full flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
      <ScrollArea
        className="hidden min-h-0 border-border bg-card/80 lg:block lg:border-r"
        viewportClassName="px-3 py-4"
      >
        <SettingsSidebar active={active} onSelect={handleSelect} projectSlug={projectSlug} />
      </ScrollArea>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="px-0 py-0 lg:hidden">
          <SheetHeader className="px-3 pt-3 pb-0">
            <SheetTitle className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
              Settings
            </SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1" viewportClassName="px-3 pb-4">
            <SettingsSidebar active={active} onSelect={handleSelect} projectSlug={projectSlug} />
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <ScrollArea className="min-h-0">
        <header className="border-border border-b bg-card/70 px-4 py-4 backdrop-blur sm:px-6">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="font-semibold text-foreground text-lg">{activeMeta.label}</h2>
            {activeMeta.needsProject && project ? (
              <span
                className={cn(
                  "rounded-full border border-border bg-muted px-2 py-0.5",
                  "text-[11px] text-muted-foreground uppercase tracking-wide",
                )}
              >
                {project.name}
              </span>
            ) : null}
          </div>
          <p className="mt-1 max-w-3xl text-muted-foreground text-sm">{activeMeta.description}</p>
        </header>

        <div className="px-4 py-6 sm:px-6">
          {blockedByMissingProject ? (
            <p className="rounded-2xl border border-border border-dashed bg-card p-6 text-center text-muted-foreground text-sm">
              Pick a project from the sidebar to manage its {activeMeta.label.toLowerCase()}.
            </p>
          ) : (
            <SectionContent active={active} projectSlug={projectSlug} publicBase={publicBase} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function SectionContent({
  active,
  projectSlug,
  publicBase,
}: {
  active: SectionKey;
  projectSlug: string | null;
  publicBase: string;
}) {
  switch (active) {
    case "memory":
      return projectSlug ? <MemoryPane projectSlug={projectSlug} /> : null;
    case "sources":
      return projectSlug ? <SourcesPane projectSlug={projectSlug} /> : null;
    case "mcp":
      return projectSlug ? <McpPane projectSlug={projectSlug} /> : null;
    case "project-llm":
      return projectSlug ? <ProjectLlmPanel projectSlug={projectSlug} /> : null;
    case "project-web-fetch":
      return projectSlug ? <WebFetchPanel projectSlug={projectSlug} /> : null;
    case "project-guardrail":
      return projectSlug ? <GuardrailPanel projectSlug={projectSlug} /> : null;
    case "project-agent-behavior":
      return projectSlug ? <AgentBehaviorPanel projectSlug={projectSlug} /> : null;
    case "project-analytics":
      return projectSlug ? <AnalyticsPanel scope="project" projectSlug={projectSlug} /> : null;
    case "project-members":
      return projectSlug ? <MembersPanel projectSlug={projectSlug} /> : null;
    case "project-export":
      return projectSlug ? <ExportPanel projectSlug={projectSlug} /> : null;
    case "project-items":
      return projectSlug ? <ProjectItemsPanel projectSlug={projectSlug} /> : null;
    case "projects":
      return <ProjectsPanel />;
    case "profile":
      return <ProfilePanel />;
    case "chat":
      return <ChatDisplayPanel />;
    case "items-list":
      return <ItemsListPanel projectSlug={projectSlug} />;
    case "item-detail":
      return <ItemDetailPanel />;
    case "budget-audit":
      return <BudgetAuditPanel />;
    case "global-analytics":
      return <AnalyticsPanel scope="global" />;
    case "llm-providers":
      return <LlmProvidersPanel />;
    case "oauth-providers":
      return <OauthProvidersPanel publicBase={publicBase} />;
    case "prompts":
      return <PromptsPanel />;
    case "read-only-mode":
      return <ReadOnlyModePanel />;
  }
}
