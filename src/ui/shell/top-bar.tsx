import { signOut } from "@/server/auth";
import { AccountMenu } from "@/ui/shell/account-menu";
import { BacklogDrawerTrigger } from "@/ui/shell/backlog-drawer-trigger";
import { LogoLink } from "@/ui/shell/logo-link";
import { ProjectSwitcher } from "@/ui/shell/project-switcher";
import { SyncButton } from "@/ui/shell/sync-button";

type ProjectOption = { id: string; name: string; providerKind: string };

/**
 * Header used inside the workspace shell. Top-left is just the Docket
 * mark; top-right collapses theme/settings/sign-out into a single account
 * popover, with the project switcher sitting right next to it. Theme is
 * intentionally absent here — it lives under /settings.
 */
export function TopBar({
  projects,
  currentProjectId,
  userLabel,
  userImage,
  readOnly = false,
}: {
  projects: ProjectOption[];
  currentProjectId: string | null;
  userLabel: string;
  userImage: string | null;
  readOnly?: boolean;
}) {
  async function handleSignOut() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <header className="flex items-center border-b border-border bg-surface px-2 py-2 sm:px-4">
      <BacklogDrawerTrigger />
      <LogoLink currentProjectId={currentProjectId} />
      <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-fg-muted">
        {currentProjectId && projects.length > 0 ? (
          <>
            <SyncButton projectId={currentProjectId} readOnly={readOnly} variant="topbar" />
            <ProjectSwitcher projects={projects} currentProjectId={currentProjectId} />
          </>
        ) : null}
        <AccountMenu
          userLabel={userLabel}
          userImage={userImage}
          signOutAction={handleSignOut}
          currentProjectId={currentProjectId}
        />
      </div>
    </header>
  );
}
