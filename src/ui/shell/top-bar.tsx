import Link from "next/link";
import { signOut } from "@/server/auth";
import { AccountMenu } from "@/ui/shell/account-menu";
import { ProjectSwitcher } from "@/ui/shell/project-switcher";

type ProjectOption = { id: string; name: string };

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
}: {
  projects: ProjectOption[];
  currentProjectId: string | null;
  userLabel: string;
}) {
  async function handleSignOut() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <header className="flex items-center border-b border-border bg-surface px-4 py-2">
      <Link
        href="/"
        className="flex shrink-0 items-center gap-2 text-fg hover:text-accent"
        aria-label="Docket"
      >
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
        />
        <span className="text-[13px] font-semibold uppercase tracking-[0.18em]">DOCKET</span>
      </Link>
      <div className="ml-auto flex shrink-0 items-center gap-3 text-xs text-fg-muted">
        {currentProjectId && projects.length > 0 ? (
          <ProjectSwitcher projects={projects} currentProjectId={currentProjectId} />
        ) : null}
        <AccountMenu
          userLabel={userLabel}
          signOutAction={handleSignOut}
          currentProjectId={currentProjectId}
        />
      </div>
    </header>
  );
}
