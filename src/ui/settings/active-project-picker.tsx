"use client";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";

/**
 * Sidebar control above the "Project" group: lets the user switch which
 * project the per-project settings sections (memory, sources, MCP)
 * operate on without leaving the settings page. Driven by the URL —
 * `/settings?project=<id>` — so a refresh keeps the same view.
 */
export function ActiveProjectPicker({ currentProjectId }: { currentProjectId: string | null }) {
  const router = useRouter();
  const projects = trpc.projects.list.useQuery();

  if (projects.isPending) {
    return <p className="px-3 text-xs text-fg-faint">Loading projects…</p>;
  }
  if (projects.error) {
    return <p className="px-3 text-xs text-danger-fg">{projects.error.message}</p>;
  }
  if (projects.data.length === 0) {
    return (
      <p className="px-3 text-xs text-fg-muted">
        No projects yet. Create one from the home page first.
      </p>
    );
  }

  return (
    <SelectField
      aria-label="Active project"
      value={currentProjectId ?? ""}
      onChange={(e) => {
        const next = e.target.value;
        if (!next) return;
        router.push(`/settings?project=${next}`);
      }}
      className="text-xs"
    >
      {currentProjectId ? null : <option value="">Pick a project…</option>}
      {projects.data.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </SelectField>
  );
}
