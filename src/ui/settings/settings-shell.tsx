"use client";
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { McpPane } from "@/ui/mcp/mcp-pane";
import { MemoryPane } from "@/ui/memory/memory-pane";
import { AnalyticsPanel } from "@/ui/settings/analytics-panel";
import { AutoAcceptPanel } from "@/ui/settings/auto-accept-panel";
import { BudgetAuditPanel } from "@/ui/settings/budget-audit-panel";
import { ChatDisplayPanel } from "@/ui/settings/chat-display-panel";
import { ExportPanel } from "@/ui/settings/export-panel";
import { GuardrailPanel } from "@/ui/settings/guardrail-panel";
import { ItemDetailPanel } from "@/ui/settings/item-detail-panel";
import { ItemsListPanel } from "@/ui/settings/items-list-panel";
import { LlmProvidersPanel } from "@/ui/settings/llm-providers-panel";
import { MembersPanel } from "@/ui/settings/members-panel";
import { OauthProvidersPanel } from "@/ui/settings/oauth-providers-panel";
import { ProfilePanel } from "@/ui/settings/profile-panel";
import { ProjectItemsPanel } from "@/ui/settings/project-items-panel";
import { ProjectLlmPanel } from "@/ui/settings/project-llm-panel";
import { ProjectsPanel } from "@/ui/settings/projects-panel";
import { ReadOnlyModePanel } from "@/ui/settings/read-only-mode-panel";
import {
  readPersistedSection,
  SECTION_STORAGE_KEY,
  SECTIONS,
  type SectionKey,
} from "@/ui/settings/sections";
import { SettingsSidebar } from "@/ui/settings/settings-sidebar";
import { SyncPanel } from "@/ui/settings/sync-panel";
import { WebFetchPanel } from "@/ui/settings/web-fetch-panel";
import { useRegisterSidebarMount, useSidebarDrawer } from "@/ui/shell/sidebar-drawer-context";
import { SourcesPane } from "@/ui/sources/sources-pane";

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

  const [active, setActive] = useState<SectionKey>(
    initialSection ?? (projectId ? "memory" : "profile"),
  );
  useRegisterSidebarMount();
  const { open: mobileNavOpen, setOpen: setMobileNavOpen } = useSidebarDrawer();

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
      window.localStorage.setItem(SECTION_STORAGE_KEY, active);
    } catch {
      // ignore
    }
  }, [active]);

  const activeMeta = SECTIONS.find((s) => s.key === active) ?? SECTIONS[0];
  if (!activeMeta) {
    throw new Error("settings shell rendered with empty SECTIONS list");
  }
  const blockedByMissingProject = Boolean(activeMeta.needsProject) && !projectId;

  const handleSelect = (key: SectionKey) => {
    setActive(key);
    setMobileNavOpen(false);
  };

  return (
    <div className="grid min-h-0 w-full flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="hidden min-h-0 overflow-auto border-border bg-surface/80 px-3 py-4 lg:block lg:border-r">
        <SettingsSidebar active={active} onSelect={handleSelect} projectId={projectId} />
      </aside>

      <Dialog
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        className="relative z-40 lg:hidden"
      >
        <DialogBackdrop className="fixed inset-0 bg-fg/30 backdrop-blur-sm" />
        <div className="fixed inset-0 flex">
          <DialogPanel className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col overflow-auto border-r border-border bg-surface px-3 py-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between px-3">
              <DialogTitle className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-muted">
                Settings
              </DialogTitle>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close menu"
                className="rounded-md p-1 text-fg-muted hover:bg-surface-alt hover:text-fg"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <SettingsSidebar active={active} onSelect={handleSelect} projectId={projectId} />
          </DialogPanel>
        </div>
      </Dialog>

      <section className="min-h-0 overflow-auto">
        <header className="border-b border-border bg-surface/70 px-4 py-4 backdrop-blur sm:px-6">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-lg font-semibold text-fg">{activeMeta.label}</h2>
            {activeMeta.needsProject && project ? (
              <span
                className={cn(
                  "rounded-full border border-border bg-surface-alt px-2 py-0.5",
                  "text-[11px] uppercase tracking-wide text-fg-muted",
                )}
              >
                {project.name}
              </span>
            ) : null}
          </div>
          <p className="mt-1 max-w-3xl text-sm text-fg-muted">{activeMeta.description}</p>
        </header>

        <div className="px-4 py-6 sm:px-6">
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
    case "project-guardrail":
      return projectId ? <GuardrailPanel projectId={projectId} /> : null;
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
    case "project-items":
      return projectId ? <ProjectItemsPanel projectId={projectId} /> : null;
    case "projects":
      return <ProjectsPanel />;
    case "profile":
      return <ProfilePanel />;
    case "chat":
      return <ChatDisplayPanel />;
    case "items-list":
      return <ItemsListPanel projectId={projectId} />;
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
    case "read-only-mode":
      return <ReadOnlyModePanel />;
  }
}
