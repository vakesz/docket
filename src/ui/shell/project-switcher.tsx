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
      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
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
