"use client";
import { useRouter } from "next/navigation";

type ProjectOption = {
  id: string;
  name: string;
};

/** Drop-down project switcher in the project shell. */
export function ProjectSwitcher({
  projects,
  currentProjectId,
}: {
  projects: ProjectOption[];
  currentProjectId: string;
}) {
  const router = useRouter();
  return (
    <select
      className="min-w-0 max-w-[12rem] truncate rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg focus:outline-none focus:ring-1 focus:ring-accent"
      value={currentProjectId}
      onChange={(e) => {
        const next = e.target.value;
        if (next && next !== currentProjectId) {
          router.push(`/projects/${next}`);
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
