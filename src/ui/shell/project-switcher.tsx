"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type ProjectOption = {
  id: string;
  name: string;
};

/**
 * Drop-down project switcher in the topbar. Routes into the new project's
 * items shell by default, but when the user is already on `/settings`
 * we stay on /settings and just rebind the active-project query param —
 * switching projects shouldn't kick the user out of settings. On
 * /settings the dropdown also reflects `?project=<id>` so the topbar
 * tracks the page's active project rather than the user's default.
 */
export function ProjectSwitcher({
  projects,
  currentProjectId,
}: {
  projects: ProjectOption[];
  currentProjectId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const onSettings = pathname?.startsWith("/settings") ?? false;

  const urlProject = onSettings ? searchParams.get("project") : null;
  const effective =
    urlProject && projects.some((p) => p.id === urlProject) ? urlProject : currentProjectId;

  return (
    <select
      className="min-w-0 max-w-[12rem] truncate rounded-full border border-border bg-surface px-3 py-1 text-xs text-fg focus:border-accent focus:outline-none"
      value={effective}
      onChange={(e) => {
        const next = e.target.value;
        if (next && next !== effective) {
          router.push(onSettings ? `/settings?project=${next}` : `/projects/${next}/items`);
        }
      }}
      aria-label="Switch project"
    >
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
