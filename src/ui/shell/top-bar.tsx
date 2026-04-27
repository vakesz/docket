import Link from "next/link";
import { ProjectSwitcher } from "@/ui/shell/project-switcher";
import { SignOutButton } from "@/ui/shell/sign-out-button";
import { ThemePicker } from "@/ui/shell/theme-picker";

type ProjectOption = { id: string; name: string };

/**
 * Header used inside the workspace shell. Server-renders the project
 * switcher (so the initial paint has the right project highlighted) and
 * embeds the localStorage-backed theme picker as a client island.
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
  return (
    <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className="flex items-center gap-2 text-sm font-semibold tracking-tight text-fg hover:text-accent"
        >
          <span className="rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-bold uppercase text-accent-fg">
            Docket
          </span>
        </Link>
        {currentProjectId ? (
          <>
            <span className="text-fg-faint">/</span>
            <ProjectSwitcher projects={projects} currentProjectId={currentProjectId} />
          </>
        ) : null}
      </div>
      <div className="flex items-center gap-3 text-xs text-fg-muted">
        <ThemePicker />
        <Link href="/settings" className="rounded px-2 py-1 hover:bg-surface-alt hover:text-fg">
          Settings
        </Link>
        <span className="hidden sm:inline">{userLabel}</span>
        <SignOutButton />
      </div>
    </header>
  );
}
